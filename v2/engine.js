'use strict'

require('dotenv').config()

const fs           = require('fs')
const path         = require('path')
const EventEmitter = require('events')
const http         = require('http')
const WebSocket    = require('ws')
const express      = require('express')
const EventStore   = require('./core/event-store')
const { computeSignals, fetchHistoricalCloses } = require('./core/signals')
const AggTradeCollector = require('./core/agg-trade-collector')
const { ConfigStore } = require('./core/config-store')
const { simEntry, simExit } = require('./core/executor')
const Agent               = require('./core/agent')
const NewsSignal          = require('./core/news-signal')
const { AdaptationEngine }    = require('./core/adaptation-engine')
const dxyFetcher              = require('./tools/dxy-fetcher')
const { PerformanceTracker }  = require('./core/performance-tracker')

const log = (...args) => process.stdout.write(new Date().toISOString() + ' [ENGINE] ' + args.join(' ') + '\n')

// ── Constants ──────────────────────────────────────────────────────────────────

const PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',
  'LTCUSDT', 'LINKUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT'
]

const CANDLE_INTERVAL = process.env.CANDLE_INTERVAL || '15m'
const CANDLE_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000,
  '15m': 900000, '30m': 1800000,
  '1h': 3600000, '2h': 7200000, '4h': 14400000
}[CANDLE_INTERVAL] || 900000

const MODE            = process.env.MODE              || 'live'
const TICK_MS         = parseInt(process.env.TICK_INTERVAL_MS) || 60000
const WS_PORT         = parseInt(process.env.PORT)     || 3001
const API_PORT        = parseInt(process.env.API_PORT) || 3002
const WS_TOKEN        = process.env.WS_TOKEN           || ''
const LIVE_AGENTS     = parseInt(process.env.LIVE_AGENTS)  || 2
const PAPER_AGENTS    = parseInt(process.env.PAPER_AGENTS) || 4
const INITIAL_CAPITAL = parseFloat(process.env.INITIAL_CAPITAL) || 5000

// ── State ─────────────────────────────────────────────────────────────────────

const store       = new EventStore('./data/events.db')
const configStore = new ConfigStore('./data/configs')

// ── DXY macro signal ──────────────────────────────────────────────────────────
const MACRO_SIGNAL_FILE = './data/macro-signal.json'
let macroSignal = { dxy: null, trend: null, advice: null, trading_paused: false, updatedAt: null }
try { macroSignal = JSON.parse(require('fs').readFileSync(MACRO_SIGNAL_FILE, 'utf8')) } catch { /* file not yet created */ }

// Refresh DXY once per day
setInterval(async () => {
  try {
    macroSignal = await dxyFetcher.run()
    log(`dxy refresh  dxy=${macroSignal.dxy?.toFixed(2)}  trend=${macroSignal.trend}  advice=${macroSignal.advice}`)
    broadcast({ type: 'dxy_update', macroSignal })
  } catch (err) { log('dxy refresh failed:', err.message) }
}, 24 * 60 * 60 * 1000)
const emitter     = new EventEmitter()
let   agentPool   = []   // populated in start()

// News signal — started in start(), null until then
let newsSignal = null
let aggTradeCollector = null

// Adaptation engine — started in start(), null until then
let adaptationEngine  = null
const perfTracker     = new PerformanceTracker('./data')

// priceHistories[pair] = array of closes, oldest first, max 700 entries (~7 days at 15m)
const priceHistories = Object.fromEntries(PAIRS.map(p => [p, []]))

// signalBuffers[pair] = last 10 signal vectors for uncertainty computation
const signalBuffers  = Object.fromEntries(PAIRS.map(p => [p, []]))

let cachedSignals  = null   // last computed signal vector array
let lastCandleAt   = 0      // wall-clock ms of last candle close
let candleCount    = 0      // total candles closed since start
let ticker         = null   // setInterval handle
let busy           = false

// ── Price fetcher (live mode) ─────────────────────────────────────────────────

async function fetchPrices() {
  const url  = `https://api.binance.com/api/v3/ticker/price?symbols=${
    encodeURIComponent(JSON.stringify(PAIRS))}`
  const data = await fetch(url, { signal: AbortSignal.timeout(5000) }).then(r => r.json())
  const map  = {}
  for (const item of data) map[item.symbol] = parseFloat(item.price)
  return map
}

async function fetchPricesSafe() {
  try {
    return await fetchPrices()
  } catch {
    // On failure return last known prices with tiny noise to avoid stale signals
    const map = {}
    for (const pair of PAIRS) {
      const h = priceHistories[pair]
      const last = h.length ? h[h.length - 1] : 1
      map[pair] = last * (1 + (Math.random() - 0.5) * 0.001)
    }
    return map
  }
}

// ── Candle close ──────────────────────────────────────────────────────────────

function pushClose(pair, price) {
  const h = priceHistories[pair]
  h.push(price)
  if (h.length > 700) h.shift()
}

async function onCandleClose(prices, timestamp) {
  // 1. Update price histories
  for (const pair of PAIRS) {
    if (prices[pair] != null) pushClose(pair, prices[pair])
  }
  candleCount++

  // 2. Compute signal vectors
  // Rotate aggTrade accumulators before computing signals (last candle → completed)
  if (aggTradeCollector) {
    for (const pair of PAIRS) aggTradeCollector.onCandleClose(pair)
  }

  const signals = await computeSignals(prices, priceHistories, {
    pairs:            PAIRS,
    interval:         CANDLE_INTERVAL,
    signalBuffers,
    newsSignal,
    aggTradeCollector
  })

  // 3. Update signal uncertainty buffers
  for (const sv of signals) {
    const buf = signalBuffers[sv.pair]
    buf.push(sv)
    if (buf.length > 10) buf.shift()
  }

  cachedSignals = signals

  // 4. Write TICK events to event store (one row per pair per candle)
  const tickEvents = signals.map(sv => ({
    type:      'tick',
    timestamp,
    pair:      sv.pair,
    mid:       sv.price,
    bid:       sv.price * 0.9995,   // approximated — real bid/ask in Phase 2
    ask:       sv.price * 1.0005,
    spread:    sv.price * 0.001,
    volume:    null,                // raw volume not available at tick level
    funding_rate:      sv.funding_rate,
    fear_greed:        sv.fear_greed,
    cvd_norm:          sv.cvd_norm,
    funding_signal:    sv.funding_signal,
    momentum_1h:       sv.momentum_1h,
    momentum_4h:       sv.momentum_4h,
    rsi_norm:          sv.rsi_norm,
    volume_zscore:     sv.volume_zscore,
    fear_greed_signal: sv.fear_greed_signal,
    signal_uncertainty: sv.signal_uncertainty,
    news_signal:       sv.news_signal ?? 0,
    p_volatile:           sv.p_volatile,
    p_trending_up:        sv.p_trending_up,
    p_trending_down:      sv.p_trending_down,
    p_ranging:            sv.p_ranging,
    macro_p_trending_up:  sv.macro_p_trending_up
  }))

  store.appendBatch(tickEvents)

  log(`candle #${candleCount}  ${CANDLE_INTERVAL}  ${signals.length} pairs`)

  // 5. Dispatch to all agents, collect and persist their actions
  const agentEvents = []
  if (agentPool.length) {
    for (const agent of agentPool) {
      const actions = agent.decide(signals, prices)
      for (const action of actions) {
        if (action.type === 'ENTRY') {
          agentEvents.push({
            type:           'entry',
            timestamp,
            agent_id:       agent.id,
            mode:           agent.mode,
            pair:           action.pair,
            price:          action.fill.price,
            size_usd:       action.size_usd,
            entry_score:    action.signal_score,
            p_volatile:     action.regimeProbs.p_volatile,
            p_trending_up:  action.regimeProbs.p_trending_up,
            p_trending_down: action.regimeProbs.p_trending_down,
            p_ranging:      action.regimeProbs.p_ranging,
            config_version: action.configVersion
          })
          log(`${agent.id}(${agent.mode}) ENTRY  ${action.pair}  @${action.fill.price.toFixed(4)}  $${action.size_usd.toFixed(0)}  score=${action.signal_score.toFixed(3)}  cfg=v${action.configVersion}`)

        } else if (action.type === 'EXIT') {
          const exitEvent = {
            type:            'exit',
            timestamp,
            agent_id:        agent.id,
            mode:            agent.mode,
            pair:            action.pair,
            exit_price:      action.fill.price,
            exit_reason:     action.exit_reason,
            holding_rounds:  action.holding_rounds,
            pnl_pct:         action.pnl_pct,
            entry_score:     action.entry_score,
            p_volatile:      action.regimeProbs.p_volatile,
            p_trending_up:   action.regimeProbs.p_trending_up,
            p_trending_down: action.regimeProbs.p_trending_down,
            p_ranging:       action.regimeProbs.p_ranging,
            config_version:  action.configVersion
          }
          agentEvents.push(exitEvent)
          perfTracker.onExit(exitEvent)
          const sign = action.pnl_pct >= 0 ? '+' : ''
          log(`${agent.id}(${agent.mode}) EXIT   ${action.pair}  @${action.fill.price.toFixed(4)}  ${sign}${action.pnl_pct.toFixed(2)}%  reason=${action.exit_reason}  held=${action.holding_rounds}r`)

        } else if (action.type === 'REJECTED') {
          agentEvents.push({
            type:            'rejected',
            timestamp,
            agent_id:        agent.id,
            pair:            action.pair,
            gate_failed:     action.gate_failed,
            signal_score:    action.signal_score,
            p_volatile:      action.regimeProbs.p_volatile,
            p_trending_up:   action.regimeProbs.p_trending_up,
            p_trending_down: action.regimeProbs.p_trending_down,
            p_ranging:       action.regimeProbs.p_ranging,
            config_version:  action.configVersion
          })
        }
      }
    }
    if (agentEvents.length) store.appendBatch(agentEvents)
  }

  const adaptCounts = adaptationEngine ? adaptationEngine.getPendingCounts() : {}
  const liveAgent   = agentPool.find(a => a.mode === 'live')
  const gateTraces  = liveAgent ? liveAgent.gateTrace(signals, prices) : {}
  perfTracker.onCandle()
  const snapshot = { candleCount, timestamp, signals, agents: agentPool.map(a => a.snapshot(prices)), agentEvents, adaptCounts, gateTraces }
  saveAgentStates()
  emitter.emit('candle', snapshot)
  broadcast({ type: 'candle', ...snapshot, macroSignal })
}

// ── Intra-candle stop scan ────────────────────────────────────────────────────

function runIntraStops(prices) {
  if (!agentPool.length) return
  const now    = Date.now()
  const events = []
  for (const agent of agentPool) {
    for (const action of agent.intraStops(prices)) {
      events.push({
        type:            'exit',
        timestamp:       now,
        agent_id:        agent.id,
        mode:            agent.mode,
        pair:            action.pair,
        exit_price:      action.fill.price,
        exit_reason:     action.exit_reason,
        holding_rounds:  action.holding_rounds,
        pnl_pct:         action.pnl_pct,
        entry_score:     action.entry_score,
        p_volatile:      action.regimeProbs?.p_volatile      ?? 0,
        p_trending_up:   action.regimeProbs?.p_trending_up   ?? 0,
        p_trending_down: action.regimeProbs?.p_trending_down ?? 0,
        p_ranging:       action.regimeProbs?.p_ranging       ?? 0,
        config_version:  action.configVersion
      })
      log(`${agent.id}(${agent.mode}) STOP(intra)  ${action.pair}  @${action.fill.price.toFixed(4)}  ${action.pnl_pct.toFixed(2)}%`)
    }
  }
  if (events.length) store.appendBatch(events)
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick() {
  const now    = Date.now()
  const prices = await fetchPricesSafe()

  if (!cachedSignals || now - lastCandleAt >= CANDLE_MS) {
    lastCandleAt = now
    await onCandleClose(prices, now)
  } else {
    // Mid-candle: run intra-candle stop scan only
    runIntraStops(prices)
  }

  emitter.emit('tick', { timestamp: now, prices, signals: cachedSignals })
  broadcast({ type: 'tick', timestamp: now, prices, signals: cachedSignals })
}

async function runTick() {
  if (busy) return
  busy = true
  try {
    await tick()
  } catch (err) {
    log('tick error:', err.message)
    emitter.emit('error', err.message)
  }
  busy = false
}

// ── Agent state persistence ───────────────────────────────────────────────────

const STATES_DIR = './data/agent-states'

function saveOneAgentState(agent) {
  if (!fs.existsSync(STATES_DIR)) fs.mkdirSync(STATES_DIR, { recursive: true })
  const file = path.join(STATES_DIR, `${agent.id}.json`)
  fs.writeFileSync(file, JSON.stringify({
    capital:               agent.capital,
    positions:             agent.positions,
    tradeHistory:          agent.tradeHistory,
    tickCount:             agent.tickCount,
    spotAccumMacroWasLow:  agent.spotAccumMacroWasLow,
    spotAccumMacroDepth:   agent.spotAccumMacroDepth
  }, null, 2))
}

function saveAgentStates() {
  for (const agent of agentPool) {
    if (agent.mode === 'paper') continue  // paper agents always reset on restart
    saveOneAgentState(agent)
  }
}

function loadAgentState(agent) {
  const file = path.join(STATES_DIR, `${agent.id}.json`)
  if (!fs.existsSync(file)) return
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    agent.capital              = state.capital              ?? agent.capital
    agent.positions            = state.positions            ?? {}
    agent.tradeHistory         = state.tradeHistory         ?? {}
    agent.tickCount            = state.tickCount            ?? 0
    agent.spotAccumMacroWasLow = state.spotAccumMacroWasLow ?? false
    agent.spotAccumMacroDepth  = state.spotAccumMacroDepth  ?? 1.0
    const posCount = Object.keys(agent.positions).length
    log(`state loaded  agent=${agent.id}  capital=$${agent.capital.toFixed(0)}  positions=${posCount}`)
  } catch (err) {
    log(`state load failed  agent=${agent.id}  ${err.message}`)
  }
}

// ── Agent pool ────────────────────────────────────────────────────────────────

function initAgentPool() {
  agentPool = []

  for (let i = 1; i <= LIVE_AGENTS; i++) {
    const id     = `A${i}`
    const config = configStore.getConfig(id)
    const ver    = configStore.getVersion(id)
    const agent  = new Agent({ id, mode: 'live', config, capital: INITIAL_CAPITAL, configVersion: ver, personality: configStore.getPersonality(id) })
    loadAgentState(agent)
    agentPool.push(agent)

    // Hot-reload: update agent config whenever the file changes
    configStore.watchForChanges(id, (agentId, newConfig, newVer) => {
      agent.updateConfig(newConfig, newVer)
      log(`config hot-reloaded  agent=${agentId}  v${newVer}`)
    })
  }

  for (let i = LIVE_AGENTS + 1; i <= LIVE_AGENTS + PAPER_AGENTS; i++) {
    const id     = `A${i}`
    const config = configStore.getConfig(id)
    const ver    = configStore.getVersion(id)
    // Paper agents always start fresh at INITIAL_CAPITAL — no state persistence
    const paperAgent = new Agent({ id, mode: 'paper', config, capital: INITIAL_CAPITAL, configVersion: ver, personality: configStore.getPersonality(id) })
    agentPool.push(paperAgent)
  }

  log(`agent pool  live=${LIVE_AGENTS}  paper=${PAPER_AGENTS}  capital=$${INITIAL_CAPITAL}/agent`)
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

async function start() {
  if (ticker) return

  log(`starting  mode=${MODE}  interval=${CANDLE_INTERVAL}  tick=${TICK_MS}ms`)

  // Start news signal (requires OPENAI_API_KEY; degrades gracefully if absent)
  const openaiKey = process.env.OPENAI_API_KEY
  let openaiClient = null
  if (openaiKey) {
    try {
      const { OpenAI } = require('openai')
      openaiClient = new OpenAI({ apiKey: openaiKey })
    } catch { /* openai package missing — skip */ }
  }
  newsSignal = new NewsSignal({ openaiClient, eventStore: store })
  await newsSignal.start()

  // Start aggTrade collector for real-time per-candle CVD
  aggTradeCollector = new AggTradeCollector(PAIRS, { candleMs: CANDLE_MS })
  await aggTradeCollector.start()

  // Initialise agent pool from config store
  initAgentPool()

  // Start adaptation engine
  adaptationEngine = new AdaptationEngine({ store, configStore, persistDir: './data/posteriors' })
  adaptationEngine.start()

  // Warm up price history from Binance before first signal computation
  log('warming price history...')
  try {
    const hist = await fetchHistoricalCloses(PAIRS, 200, CANDLE_INTERVAL)
    for (const [pair, closes] of Object.entries(hist)) {
      priceHistories[pair] = closes
    }
    log(`history warmed  pairs=${Object.keys(hist).length}`)
  } catch (err) {
    log('history warmup failed:', err.message)
  }

  await runTick()
  ticker = setInterval(runTick, TICK_MS)
}

function stop() {
  if (ticker) { clearInterval(ticker); ticker = null }
  if (adaptationEngine) adaptationEngine.stop()
  if (aggTradeCollector) aggTradeCollector.stop()
  log('stopped')
}

// ── WebSocket server ──────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.writeHead(200).end('agent-battle-gpt v2')
})

const wss = new WebSocket.Server({ server: httpServer })
const clients = new Set()

wss.on('connection', (ws, request) => {
  // Simple token auth via query param: ?token=xxx
  const url   = new URL(request.url, 'http://localhost')
  const token = url.searchParams.get('token') || ''
  if (WS_TOKEN && token !== WS_TOKEN) {
    ws.close(1008, 'unauthorized')
    return
  }

  clients.add(ws)

  // Send current state immediately on connect
  if (cachedSignals) {
    const lastPrices = Object.fromEntries(
      Object.entries(priceHistories).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
    )
    ws.send(JSON.stringify({
      type: 'candle', candleCount, signals: cachedSignals,
      agents: agentPool.map(a => a.snapshot(lastPrices)), macroSignal
    }))
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'force_candle') {
        log('force_candle requested by TUI')
        lastCandleAt = 0   // trick tick() into treating next call as a candle close
        runTick()
      } else if (msg.type === 'adapt_trigger') {
        log('adapt_trigger requested by TUI')
        if (adaptationEngine) {
          adaptationEngine.poll()
            .then(({ results, metaResults }) => broadcast({ type: 'adapt_result', results, metaResults }))
            .catch(err => { log('adapt error:', err.message); broadcast({ type: 'adapt_result', error: err.message }) })
        }
      } else if (msg.type === 'force_dxy_refresh') {
        log('force_dxy_refresh requested by TUI')
        dxyFetcher.run()
          .then(result => {
            macroSignal = result
            broadcast({ type: 'dxy_update', macroSignal })
          })
          .catch(err => { log('dxy fetch failed:', err.message) })
      } else if (msg.type === 'set_trading_paused') {
        macroSignal.trading_paused = !!msg.paused
        require('fs').writeFileSync(MACRO_SIGNAL_FILE, JSON.stringify(macroSignal, null, 2))
        log(`trading_paused set to ${macroSignal.trading_paused} by TUI`)
        broadcast({ type: 'dxy_update', macroSignal })
      } else if (msg.type === 'manual_sell') {
        const { agent_id, posId } = msg
        const agent = agentPool.find(a => a.id === agent_id)
        const reply = (ok, extra) => ws.send(JSON.stringify({ type: 'manual_sell_result', ok, agent_id, posId, ...extra }))

        if (!agent)               { reply(false, { error: `agent ${agent_id} not found` }); return }
        const pos = agent.positions[posId]
        if (!pos)                 { reply(false, { error: `position ${posId} introuvable` }); return }

        const pair     = pos.pair || posId
        const priceArr = priceHistories[pair]
        const mid = priceArr && priceArr.length ? priceArr[priceArr.length - 1] : null
        if (!mid)                 { reply(false, { error: `pas de prix pour ${pair}` }); return }

        const fill = simExit(pos.entryPrice, mid, pos.sizeUsd)
        agent.capital += pos.sizeUsd + fill.pnl_usd - fill.fee_usd
        delete agent.positions[posId]

        const timestamp = Date.now()
        const exitEvent = {
          type: 'exit', timestamp,
          agent_id: agent.id, mode: agent.mode, pair,
          exit_price:     fill.price,
          exit_reason:    'manual',
          holding_rounds: agent.tickCount - pos.entryTick,
          pnl_pct:        fill.pnl_pct,
          entry_score:    pos.entryScore || 0,
          p_volatile: 0, p_trending_up: 0, p_trending_down: 0, p_ranging: 0,
          config_version: agent.configVersion
        }
        store.append(exitEvent)
        perfTracker.onExit(exitEvent)
        const sign = fill.pnl_pct >= 0 ? '+' : ''
        log(`${agent.id} MANUAL_SELL  ${pair}  @${fill.price.toFixed(2)}  ${sign}${fill.pnl_pct.toFixed(2)}%`)
        saveOneAgentState(agent)

        const lastPrices = Object.fromEntries(
          Object.entries(priceHistories).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
        )
        broadcast({
          type:     'manual_sell_result',
          ok:       true,
          agent_id: agent.id,
          pair,
          price:    fill.price,
          pnl_pct:  fill.pnl_pct,
          agents:   agentPool.map(a => a.snapshot(lastPrices))
        })
      } else if (msg.type === 'manual_toggle_block') {
        const { agent_id, posId } = msg
        const agent = agentPool.find(a => a.id === agent_id)
        const reply = (ok, extra) => ws.send(JSON.stringify({ type: 'manual_toggle_block_result', ok, agent_id, posId, ...extra }))

        if (!agent)             { reply(false, { error: `agent ${agent_id} not found` }); return }
        const pos = agent.positions[posId]
        if (!pos)               { reply(false, { error: `position ${posId} introuvable` }); return }

        const pair = pos.pair || posId
        pos.blocked = !pos.blocked
        saveOneAgentState(agent)
        log(`${agent.id} ${pos.blocked ? 'BLOCK' : 'UNBLOCK'}  ${pair}`)

        const lastPrices = Object.fromEntries(
          Object.entries(priceHistories).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
        )
        broadcast({
          type:     'manual_toggle_block_result',
          ok:       true,
          agent_id: agent.id,
          pair,
          blocked:  pos.blocked,
          agents:   agentPool.map(a => a.snapshot(lastPrices))
        })
      } else if (msg.type === 'adapt_reset') {
        const targets = msg.agent_id ? [msg.agent_id] : configStore.listAgents()
        log(`adapt_reset requested by TUI  targets=${targets.join(',')}`)
        if (adaptationEngine) targets.forEach(id => adaptationEngine.resetAgent(id))
        broadcast({ type: 'adapt_reset_done', agents: targets })
      } else if (msg.type === 'manual_buy') {
        const { agent_id, pair, amountUsd } = msg
        const agent = agentPool.find(a => a.id === agent_id)
        const reply = (ok, extra) => ws.send(JSON.stringify({ type: 'manual_buy_result', ok, agent_id, pair, ...extra }))

        if (!agent)  { reply(false, { error: `agent ${agent_id} not found` }); return }

        const priceArr = priceHistories[pair]
        const mid = priceArr && priceArr.length ? priceArr[priceArr.length - 1] : null
        if (!mid)    { reply(false, { error: `pas de prix pour ${pair}` }); return }

        const sizeUsd = Math.min(amountUsd, agent.capital * 0.99)
        if (sizeUsd < 1) { reply(false, { error: `capital insuffisant (${agent.capital.toFixed(0)} USD)` }); return }

        const fill  = simEntry(mid, sizeUsd)
        const posId = `${pair}_${Date.now()}`
        agent.capital -= sizeUsd
        agent.positions[posId] = {
          pair,
          entryPrice:  fill.price,
          sizeUsd,
          entryScore:  0,
          entryTick:   agent.tickCount,
          entryRegime: 'manual'
        }

        const timestamp = Date.now()
        store.append({
          type: 'entry', timestamp,
          agent_id: agent.id, mode: agent.mode, pair,
          price: fill.price, size_usd: sizeUsd, entry_score: 0,
          p_volatile: 0, p_trending_up: 0, p_trending_down: 0, p_ranging: 0,
          config_version: agent.configVersion, manual: true
        })
        log(`${agent.id} MANUAL_BUY  ${pair}  @${fill.price.toFixed(2)}  $${sizeUsd.toFixed(0)}`)
        saveOneAgentState(agent)

        const lastPrices = Object.fromEntries(
          Object.entries(priceHistories).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
        )
        broadcast({
          type:     'manual_buy_result',
          ok:       true,
          agent_id: agent.id,
          pair,
          price:    fill.price,
          size_usd: sizeUsd,
          agents:   agentPool.map(a => a.snapshot(lastPrices))
        })
      }
    } catch { /* ignore malformed messages */ }
  })

  ws.on('close', () => {
    clients.delete(ws)
  })

  ws.on('error', () => clients.delete(ws))
})

function broadcast(msg) {
  if (!clients.size) return
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

httpServer.listen(WS_PORT, () => {
  log(`ws server listening  port=${WS_PORT}`)
})

// ── REST API ──────────────────────────────────────────────────────────────────

const api = express()
api.use(express.json())

api.get('/health', (_req, res) => {
  res.json({ ok: true, candleCount, uptime: process.uptime() })
})

api.get('/state', (_req, res) => {
  const prices = Object.fromEntries(
    Object.entries(priceHistories).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
  )
  res.json({ candleCount, signals: cachedSignals || [], agents: agentPool.map(a => a.snapshot(prices)) })
})

api.get('/events', (req, res) => {
  const { type = 'exit', agent_id, pair, mode, from_ts, to_ts, config_version, limit, order } = req.query
  try {
    const rows = store.query(type, {
      agent_id,
      pair,
      mode,
      from_ts:        from_ts        ? parseInt(from_ts)        : undefined,
      to_ts:          to_ts          ? parseInt(to_ts)          : undefined,
      config_version: config_version ? parseInt(config_version) : undefined,
      limit:          limit          ? parseInt(limit)          : 200,
      order:          order || 'desc'
    })
    res.json(rows)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

api.get('/config/:id', (req, res) => {
  const config  = configStore.getConfig(req.params.id)
  const version = configStore.getVersion(req.params.id)
  if (!config) return res.status(404).json({ error: 'agent not found' })
  res.json({ id: req.params.id, version, config })
})

api.post('/config/:id', (req, res) => {
  const { config, reason = 'manual override via API' } = req.body
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'body.config is required' })
  try {
    const newVersion = configStore.setConfig(req.params.id, config, reason)
    res.json({ id: req.params.id, version: newVersion })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

api.get('/agents', (_req, res) => res.json(configStore.listAgents()))

api.get('/performance', (_req, res) => res.json(perfTracker.getStats()))

api.get('/activity/:id', (req, res) => {
  const { id } = req.params
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000)
  try {
    const filters = { agent_id: id, limit, order: 'desc' }
    const entries  = store.query('entry',    filters).map(r => ({ ...r, type: 'entry' }))
    const exits    = store.query('exit',     filters).map(r => ({ ...r, type: 'exit' }))
    const rejected = store.query('rejected', filters).map(r => ({ ...r, type: 'rejected' }))
    const merged = [...entries, ...exits, ...rejected]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
    res.json(merged)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

api.post('/adapt/trigger', async (_req, res) => {
  if (!adaptationEngine) return res.status(503).json({ error: 'not running' })
  try { const r = await adaptationEngine.poll(); res.json({ ok: true, ...r }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

api.post('/adapt/reset/:id', (req, res) => {
  if (!adaptationEngine) return res.status(503).json({ error: 'not running' })
  const targets = req.params.id === 'all' ? configStore.listAgents() : [req.params.id]
  targets.forEach(id => adaptationEngine.resetAgent(id))
  res.json({ ok: true, reset: targets })
})

api.listen(API_PORT, () => log(`api listening  port=${API_PORT}`))

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  emitter,
  store,
  configStore,
  getAgentPool:          () => agentPool,
  getPriceHistories:     () => priceHistories,
  getCachedSignals:      () => cachedSignals,
  getCandleCount:        () => candleCount,
  getAdaptationEngine:   () => adaptationEngine,
  PAIRS,
  CANDLE_INTERVAL
}

// Auto-start when run directly
if (require.main === module) {
  start().catch(err => {
    log('fatal:', err.message)
    process.exit(1)
  })

  process.on('SIGINT',  () => { stop(); store.close(); process.exit(0) })
  process.on('SIGTERM', () => { stop(); store.close(); process.exit(0) })
}
