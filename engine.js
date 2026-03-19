'use strict'

const VERSION = '1.0.6'

require('dotenv').config()
const EventEmitter = require('events')
const OpenAI       = require('openai')
const World        = require('./core/world')
const { C }        = require('./core/world')
const signals      = require('./core/signals')
const strategy     = require('./core/strategy')
const { synthesize } = require('./core/agent')
const executor       = require('./core/executor')

const log = (...args) => console.log(new Date().toISOString(), '[ENGINE]', ...args)

// ── Market price fetcher ───────────────────────────────────────────────────────
async function fetchPrices(world) {
  try {
    const url  = `https://api.binance.com/api/v3/ticker/price?symbols=${
      encodeURIComponent(JSON.stringify(C.PAIRS))}`
    const data = await fetch(url).then(r => r.json())
    const map  = {}
    data.forEach(item => { map[item.symbol] = parseFloat(item.price) })
    return map
  } catch {
    const snap = world.getSnapshot()
    const last = snap.priceHistory
    const map  = {}
    C.PAIRS.forEach(p => {
      const history = last[p] || []
      const prev    = history[history.length - 1] || 1
      map[p] = prev * (1 + (Math.random() - 0.5) * 0.003)
    })
    return map
  }
}

// ── Signal cache — recompute only when a new candle closes ────────────────────
const CANDLE_INTERVAL_LABEL = process.env.CANDLE_INTERVAL || '15m'
const CANDLE_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000,
  '15m': 900000, '30m': 1800000,
  '1h': 3600000, '2h': 7200000, '4h': 14400000
}[CANDLE_INTERVAL_LABEL] || 900000  // default 15m

let cachedSigs   = null
let lastCandleAt = 0

// ── Core tick ─────────────────────────────────────────────────────────────────
async function tick(world, openai, emitter) {
  const prices = await fetchPrices(world)

  const now = Date.now()
  if (!cachedSigs || now - lastCandleAt >= CANDLE_MS) {
    // Close the candle: push current price into priceHistory, then recompute signals
    world.updatePrices(prices)
    cachedSigs   = await signals.computeSignals(prices, world.getPriceHistory(), { interval: CANDLE_INTERVAL_LABEL })
    lastCandleAt = now
    emitter.emit('candle', { interval: CANDLE_INTERVAL_LABEL, signals: cachedSigs })
    // Refresh macro trend once per hour
    if (now - _lastDailyFetch > 3600000) _refreshMacroTrend().catch(() => {})
  } else {
    // Mid-candle: update live prices, then run intra-candle stop-loss scan
    world.setLivePrices(prices)
    const regime = cachedSigs?.[0]?.regime || 'ranging'
    const stops  = strategy.intraStopLoss(world.getSnapshot(), prices, regime)
    for (const { name, pair, pct, threshold, isShort } of stops) {
      const action = isShort ? 'COVER' : 'SELL'
      const d = {
        action,
        pair,
        amount_usd:      0,
        enforced_reason: isShort ? 'short_stop_loss' : 'stop_loss',
        reasoning:       `[STOP] ${name} intra-candle ${isShort ? 'short' : 'long'} stop-loss: ${pct.toFixed(1)}% on ${pair} exceeds -${threshold}%`,
        signal_score:    0,
        personality:     world.getSnapshot().agents[name]?.personality || ''
      }
      const result = world.applyDecision(name, d, prices)
      emitter.emit('trade', { ...result, agent: name })
      log(`[STOP] ${name} ${pair} ${isShort ? 'short' : 'long'} stopped out at ${pct.toFixed(1)}% (threshold: -${threshold}%)`)
    }
  }

  const sigs = cachedSigs

  // Sync MEGA's capital/holdings from real Binance account before building contexts
  if (executor.REAL_TRADING) {
    log('MEGA real trading active — syncing Binance state...')
    await executor.syncMegaState(world, prices)
  }

  const alive   = Object.values(world.getSnapshot().agents).filter(a => a.alive)
  const ctxs    = alive.map(a => world.getPromptContext(a.name, sigs, prices))

  // Deterministic strategy decisions — no LLM involved
  const decisions = ctxs.map(ctx => strategy.decide(ctx))

  // Periodic LLM synthesis: update personality every N rounds (not every tick)
  const round = world.getSnapshot().round
  if (round % C.STRATEGY.SYNTHESIS_EVERY_N_ROUNDS === 0) {
    await Promise.all(ctxs.map(async (ctx, i) => {
      decisions[i].personality = await synthesize(ctx, openai)
    }))
  }

  for (let i = 0; i < decisions.length; i++) {
    const d      = decisions[i]
    const name   = alive[i].name
    const result = world.applyDecision(name, d, prices)

    // After-trade synthesis for MEGA: refresh personality using post-trade context
    if (name === 'MEGA' && d.action !== 'HOLD') {
      const updatedCtx = world.getPromptContext('MEGA', sigs, prices)
      d.personality = await synthesize(updatedCtx, openai)
      // Patch snapshot so TUI reflects post-trade personality immediately
      world._snapshot.agents['MEGA'].personality = d.personality
    }

    emitter.emit('trade', { ...result, decision: { ...result.decision, personality: d.personality }, agent: name })
    if (name === 'MEGA' && executor.REAL_TRADING) {
      log(`MEGA decision → ${d.action}${d.pair ? ' ' + d.pair : ''}${d.amount_usd ? ' $' + Math.round(d.amount_usd) : ''}`)
      const fill = await executor.execute(d, prices)

      // Patch entry price with real Binance fill price (replaces sim ask-price estimate)
      if (fill && d.action === 'BUY' && d.pair && fill.fillPrice) {
        world._snapshot.agents['MEGA'].entryPrices[d.pair] = fill.fillPrice
        log(`MEGA entry price: ${d.pair} sim=$${prices[d.pair]?.toFixed(4)} real=$${fill.fillPrice.toFixed(4)}`)
      }

      // Use live snapshot for daily loss check (syncMegaState already patched it)
      const megaLive = world._snapshot.agents['MEGA']
      if (megaLive) {
        const total = megaLive.capital + Object.entries(megaLive.holdings || {})
          .reduce((s, [p, q]) => s + (prices[p] ? q * prices[p] : 0), 0)
        log(`MEGA post-tick: capital=$${Math.round(megaLive.capital)}  total=$${Math.round(total)}`)
        executor.checkDailyLoss(total)
      }
    }
  }

  world.endTick(sigs)

  const snap = world.getSnapshot()
  emitter.emit('tick', snap)

  const stillAlive = Object.values(snap.agents).filter(a => a.alive)
  if (stillAlive.length === 1) {
    emitter.emit('winner', stillAlive[0].name)
    stop()
  }
}

// ── Macro trend (BTC daily SMA200) ────────────────────────────────────────────
let _macroTrend     = { trend: 'neutral', bullCount: 0, bearCount: 0, neutralCount: 0, total: C.PAIRS.length, breadth: 0, btc: { trend: 'neutral', price: null, sma: null, pct: null, slope: null, slopeDir: 'flat', period: null } }
let _lastDailyFetch = 0

async function _refreshMacroTrend() {
  try {
    const results = await Promise.all(
      C.PAIRS.map(async pair => {
        try {
          const url    = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=210`
          const bars   = await fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => r.json())
          return [pair, bars.map(b => parseFloat(b[4]))]
        } catch {
          return [pair, []]
        }
      })
    )
    const closesByPair = Object.fromEntries(results)
    _macroTrend        = signals.computeMacroTrend(closesByPair)
    _lastDailyFetch    = Date.now()
    const { trend, bullCount, bearCount, neutralCount, btc } = _macroTrend
    const btcStr = btc?.pct != null ? `  BTC ${btc.pct > 0 ? '+' : ''}${btc.pct}% vs SMA${btc.period}  slope: ${btc.slopeDir}` : ''
    log(`Macro trend: ${trend.toUpperCase()} (${bullCount}▲ ${bearCount}▼ ${neutralCount}~${btcStr})`)
  } catch (err) {
    log(`Macro trend fetch failed: ${err.message}`)
  }
}

// ── Price history warmup ───────────────────────────────────────────────────────

/**
 * Fetch the last 50 1h closes from Binance for every pair and seed the
 * in-memory priceHistory so signals are meaningful from round 1.
 * Only runs when the history is empty (fresh DB — not on restarts).
 */
async function _warmHistory(world) {
  const history = world.getPriceHistory()
  const isEmpty = Object.values(history).every(h => h.length === 0)
  if (!isEmpty) return  // already populated from DB replay

  const results = await Promise.allSettled(
    C.PAIRS.map(async pair => {
      const url  = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${CANDLE_INTERVAL_LABEL}&limit=50`
      const bars = await fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => r.json())
      return [pair, bars.map(b => parseFloat(b[4]))]  // index 4 = close price
    })
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [pair, closes] = result.value
      if (closes.length > 0) history[pair] = closes
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
const world   = new World('./data/sim.db')
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const emitter = new EventEmitter()

// Warm up price history + macro trend — awaited before the first tick fires.
const _warmupReady = Promise.all([
  _warmHistory(world).catch(() => {}),
  _refreshMacroTrend().catch(() => {})
])

let timer      = null
let busy       = false
let interval   = parseInt(process.env.TICK_INTERVAL_MS) || 60000
let lastTickAt = null

function start() {
  if (timer) return
  world._snapshot.running = true
  runTick()
  timer = setInterval(runTick, interval)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  world._snapshot.running = false
}

/** Resolves when no tick is in flight. Max wait: 30s. */
function waitIdle() {
  if (!busy) return Promise.resolve()
  return new Promise(resolve => {
    const deadline = Date.now() + 30000
    const check = () => {
      if (!busy || Date.now() > deadline) return resolve()
      setTimeout(check, 100)
    }
    setTimeout(check, 100)
  })
}

function setInterval_(ms) {
  interval = ms
  if (timer) { stop(); start() }
}

async function runTick() {
  if (busy) return
  busy = true
  lastTickAt = Date.now()
  try {
    await _warmupReady  // no-op after first tick; ensures history is seeded before signals run
    await tick(world, openai, emitter)
  } catch (err) {
    emitter.emit('error', err.message)
  }
  busy = false
}

module.exports = { world, emitter, start, stop, waitIdle, setInterval_, runTick, getIntervalMs: () => interval, getLastTickAt: () => lastTickAt, getMacroTrend: () => _macroTrend, getOpenAI: () => openai, VERSION }
