'use strict'

// tools/replay.js — Replay tick events from events.db through a fresh agent pool.
//
// Usage:
//   node tools/replay.js                                      # full history, max speed
//   node tools/replay.js --src ./data/backtest.db             # use backfill DB
//   node tools/replay.js --from 2025-01-01                    # replay from date
//   node tools/replay.js --test-from 2025-07-01               # train/test split
//   node tools/replay.js --speed 10                           # 10× real time
//   node tools/replay.js --dry-run                            # print only, no DB write
//   node tools/replay.js --out ./data/replay.db               # custom output DB
//
// Train/test split:
//   --from       start of training window (agents adapt freely)
//   --test-from  start of test window (agents frozen — no adaptation)
//   Metrics are reported separately for train and test periods.
//
// How it works:
//   1. Reads all 'tick' rows from source DB, grouped by candle timestamp
//   2. Reconstructs SignalVector objects from stored columns (no Binance calls)
//   3. Runs each candle through a fresh agent pool using the same Agent class
//   4. Writes ENTRY/EXIT/REJECTED events to --out DB (default: data/replay.db)
//   5. Prints a full performance report (Sharpe, max drawdown, win rate, P&L)

require('dotenv').config()

const EventStore  = require('../core/event-store')
const { ConfigStore } = require('../core/config-store')
const Agent       = require('../core/agent')
const { classifyRegime } = require('../core/regime')
const { computeCvd1c } = require('../core/signals')

const log = (...args) => process.stdout.write(new Date().toISOString() + ' [REPLAY] ' + args.join(' ') + '\n')

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { speed: 0, from: null, testFrom: null, dryRun: false, out: './data/replay.db', src: './data/events.db', configDir: './data/configs' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--speed'      && argv[i+1]) { args.speed     = parseFloat(argv[++i]);               continue }
    if (argv[i] === '--from'       && argv[i+1]) { args.from      = new Date(argv[++i]).getTime();       continue }
    if (argv[i] === '--test-from'  && argv[i+1]) { args.testFrom  = new Date(argv[++i]).getTime();       continue }
    if (argv[i] === '--out'        && argv[i+1]) { args.out       = argv[++i];                           continue }
    if (argv[i] === '--src'        && argv[i+1]) { args.src       = argv[++i];                           continue }
    if (argv[i] === '--config-dir' && argv[i+1]) { args.configDir = argv[++i];                           continue }
    if (argv[i] === '--dry-run')                  { args.dryRun    = true;                               continue }
  }
  return args
}

// ── Sleep helper ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = parseArgs(process.argv)
  const srcDb   = new EventStore(args.src)
  const outDb   = args.dryRun ? null : new EventStore(args.out)

  // Use configs from data/configs/ (same as live — replay shares config state)
  const configStore = new ConfigStore(args.configDir)

  const LIVE_AGENTS  = parseInt(process.env.LIVE_AGENTS)  || 2
  const PAPER_AGENTS = parseInt(process.env.PAPER_AGENTS) || 4
  const CAPITAL      = parseFloat(process.env.INITIAL_CAPITAL) || 5000

  // Fresh agent pool — starts from scratch regardless of live state
  const agentPool = []
  for (let i = 1; i <= LIVE_AGENTS; i++) {
    const id = `A${i}`
    agentPool.push(new Agent({ id, mode: 'live', config: configStore.getConfig(id),
      capital: CAPITAL, configVersion: configStore.getVersion(id) }))
  }
  for (let i = LIVE_AGENTS + 1; i <= LIVE_AGENTS + PAPER_AGENTS; i++) {
    const id = `A${i}`
    agentPool.push(new Agent({ id, mode: 'paper', config: configStore.getConfig(id),
      capital: CAPITAL, configVersion: configStore.getVersion(id) }))
  }

  // ── Load tick rows ──────────────────────────────────────────────────────────

  const allTicks = srcDb.query('tick', {
    from_ts: args.from || undefined,
    order:   'asc',
    limit:   1000000
  })

  if (!allTicks.length) {
    log('no tick events found in', args.src)
    srcDb.close()
    return
  }

  log(`loaded ${allTicks.length} tick rows  from=${new Date(allTicks[0].timestamp).toISOString()}`)

  // 4h macro regime tracking
  const hist4h     = {}   // pair → rolling array of 4h closes (max 30)
  const lastBdry4h = {}   // pair → last 4h boundary timestamp
  const FOUR_H_MS  = 4 * 60 * 60 * 1000

  // Weekly regime tracking
  const histWeekly  = {}   // pair → rolling array of weekly closes (max 30)
  const lastBdryWk  = {}   // pair → last week boundary timestamp
  const WEEK_MS     = 7 * 24 * 60 * 60 * 1000

  // BTC 200-day MA tracking
  const histDailyBtc = []  // daily BTC closes (max 210)
  const DAY_MS       = 24 * 60 * 60 * 1000
  let   lastDayBdry  = 0

  // Group by candle timestamp (one tick row per pair per candle)
  const candleMap = new Map()
  for (const tick of allTicks) {
    const key = tick.timestamp
    if (!candleMap.has(key)) candleMap.set(key, [])
    candleMap.get(key).push(tick)
  }

  const candles      = [...candleMap.entries()].sort((a, b) => a[0] - b[0])
  let   prevTs       = candles[0][0]
  let   candleCount  = 0
  let   totalEntries = 0, totalExits = 0

  // ── Per-agent equity tracking (for Sharpe / drawdown) ───────────────────────
  // equity[agentId] = { train: [{ts, capital}], test: [{ts, capital}] }
  const equity = {}
  for (const agent of agentPool) {
    equity[agent.id] = { train: [], test: [] }
  }

  // ── Replay loop ──────────────────────────────────────────────────────────────

  for (const [timestamp, ticks] of candles) {
    candleCount++
    const inTest = args.testFrom && timestamp >= args.testFrom

    // Update 4h buffers for each tick in this candle
    for (const t of ticks) {
      const bdry = Math.floor(timestamp / FOUR_H_MS) * FOUR_H_MS
      if (bdry !== lastBdry4h[t.pair]) {
        lastBdry4h[t.pair] = bdry
        if (!hist4h[t.pair]) hist4h[t.pair] = []
        hist4h[t.pair].push(t.mid)
        if (hist4h[t.pair].length > 30) hist4h[t.pair].shift()
      }

      // Update weekly buffers
      const wkBdry = Math.floor(timestamp / WEEK_MS) * WEEK_MS
      if (wkBdry !== lastBdryWk[t.pair]) {
        lastBdryWk[t.pair] = wkBdry
        if (!histWeekly[t.pair]) histWeekly[t.pair] = []
        histWeekly[t.pair].push(t.mid)
        if (histWeekly[t.pair].length > 30) histWeekly[t.pair].shift()
      }
    }

    // Update BTC daily close for 200-day MA
    const dayBdry = Math.floor(timestamp / DAY_MS) * DAY_MS
    if (dayBdry !== lastDayBdry) {
      lastDayBdry = dayBdry
      const btcTick = ticks.find(t => t.pair === 'BTCUSDT')
      if (btcTick) {
        histDailyBtc.push(btcTick.mid)
        if (histDailyBtc.length > 210) histDailyBtc.shift()
      }
    }

    // BTC 200-day SMA ratio (price / SMA200); defaults to 1.0 until 200 days of data
    const btcSma200    = histDailyBtc.length >= 200
      ? histDailyBtc.slice(-200).reduce((s, v) => s + v, 0) / 200
      : null
    const btcPriceNow  = ticks.find(t => t.pair === 'BTCUSDT')?.mid ?? null
    const btcAbove200d = (btcSma200 && btcPriceNow) ? btcPriceNow / btcSma200 : 1.0

    const prices  = {}
    const signals = ticks.map(t => {
      prices[t.pair] = t.mid
      const macro4h   = classifyRegime(hist4h[t.pair]   || [], '4h')
      const weekly    = classifyRegime(histWeekly[t.pair] || [], '1w')
      return {
        pair:               t.pair,
        price:              t.mid,
        cvd_norm:           t.cvd_norm           ?? 0,
        cvd_1c:             t.cvd_1c != null
          ? t.cvd_1c
          : (t.taker_buy_vol != null && t.volume > 0
              ? computeCvd1c(t.volume, t.taker_buy_vol)
              : 0),
        cvd_intra:          0,
        cvd_accel:          0,
        funding_signal:     t.funding_signal      ?? 0,
        momentum_1h:        t.momentum_1h         ?? 0,
        momentum_4h:        t.momentum_4h         ?? 0,
        rsi_norm:           t.rsi_norm            ?? 0,
        volume_zscore:      t.volume_zscore       ?? 0,
        fear_greed_signal:  t.fear_greed_signal   ?? 0,
        news_signal:        t.news_signal         ?? 0,
        signal_uncertainty: t.signal_uncertainty  ?? 0,
        p_volatile:         t.p_volatile          ?? 0.25,
        p_trending_up:      t.p_trending_up       ?? 0.25,
        p_trending_down:    t.p_trending_down     ?? 0.25,
        p_ranging:          t.p_ranging           ?? 0.25,
        macro_p_volatile:      macro4h.p_volatile,
        macro_p_trending_up:   macro4h.p_trending_up,
        macro_p_trending_down: macro4h.p_trending_down,
        macro_p_ranging:       macro4h.p_ranging,
        weekly_p_volatile:     weekly.p_volatile,
        weekly_p_trending_up:  weekly.p_trending_up,
        weekly_p_trending_down:weekly.p_trending_down,
        weekly_p_ranging:      weekly.p_ranging,
        btc_above_200d:        btcAbove200d
      }
    })

    const agentEvents = []
    for (const agent of agentPool) {
      for (const action of agent.decide(signals, prices)) {
        if (action.type === 'ENTRY') {
          totalEntries++
          const ev = {
            type: 'entry', timestamp,
            agent_id: agent.id, mode: agent.mode,
            pair: action.pair, price: action.fill.price,
            size_usd: action.size_usd, entry_score: action.signal_score,
            p_volatile: action.regimeProbs.p_volatile,
            p_trending_up: action.regimeProbs.p_trending_up,
            p_trending_down: action.regimeProbs.p_trending_down,
            p_ranging: action.regimeProbs.p_ranging,
            config_version: action.configVersion
          }
          agentEvents.push(ev)
          if (args.dryRun) log(`ENTRY  ${agent.id}  ${action.pair}  $${action.size_usd.toFixed(0)}  score=${action.signal_score.toFixed(3)}`)

        } else if (action.type === 'EXIT') {
          totalExits++
          const sign = action.pnl_pct >= 0 ? '+' : ''
          const ev = {
            type: 'exit', timestamp,
            agent_id: agent.id, mode: agent.mode,
            pair: action.pair, exit_price: action.fill.price,
            exit_reason: action.exit_reason,
            holding_rounds: action.holding_rounds, pnl_pct: action.pnl_pct,
            entry_score: action.entry_score,
            p_volatile: action.regimeProbs.p_volatile,
            p_trending_up: action.regimeProbs.p_trending_up,
            p_trending_down: action.regimeProbs.p_trending_down,
            p_ranging: action.regimeProbs.p_ranging,
            config_version: action.configVersion
          }
          agentEvents.push(ev)
          if (args.dryRun) log(`EXIT   ${agent.id}  ${action.pair}  ${sign}${action.pnl_pct.toFixed(2)}%  reason=${action.exit_reason}`)
        }
      }

      // Sample equity every 96 candles (≈ 1 day at 15m) for Sharpe/drawdown
      if (candleCount % 96 === 0) {
        const snap = agent.snapshot(prices)
        const bucket = inTest ? 'test' : 'train'
        equity[agent.id][bucket].push({ ts: timestamp, capital: snap.totalValue })
      }
    }

    if (outDb && agentEvents.length) outDb.appendBatch(agentEvents)

    if (args.speed > 0) {
      const replayDelay = (timestamp - prevTs) / args.speed
      if (replayDelay > 5) await sleep(replayDelay)
    }
    prevTs = timestamp

    if (candleCount % 500 === 0) {
      const pct = ((candleCount / candles.length) * 100).toFixed(0)
      log(`progress ${pct}%  candle ${candleCount}/${candles.length}  entries=${totalEntries}  exits=${totalExits}`)
    }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────

  function calcMetrics(snapshots, startCapital) {
    if (snapshots.length < 2) return null
    const dailyReturns = []
    for (let i = 1; i < snapshots.length; i++) {
      dailyReturns.push((snapshots[i].capital - snapshots[i-1].capital) / snapshots[i-1].capital)
    }
    const meanRet  = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length
    const m        = meanRet
    const variance = dailyReturns.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, dailyReturns.length - 1)
    const stdRet   = Math.sqrt(variance)
    const sharpe   = stdRet === 0 ? 0 : (meanRet / stdRet) * Math.sqrt(252)

    let peak = startCapital, maxDd = 0
    for (const s of snapshots) {
      if (s.capital > peak) peak = s.capital
      const dd = (peak - s.capital) / peak
      if (dd > maxDd) maxDd = dd
    }

    const finalCapital = snapshots[snapshots.length - 1].capital
    const cumPnl = ((finalCapital - startCapital) / startCapital * 100)
    return { sharpe: sharpe.toFixed(2), maxDd: (maxDd * 100).toFixed(1), cumPnl: cumPnl.toFixed(2), days: snapshots.length }
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  const SEP  = '─'.repeat(80)
  const SEP2 = '═'.repeat(80)

  log(`\n${SEP2}`)
  log(`REPLAY COMPLETE   candles=${candleCount}  entries=${totalEntries}  exits=${totalExits}`)
  if (args.testFrom) log(`TRAIN → ${new Date(args.testFrom).toISOString().slice(0,10)}  TEST ← ${new Date(args.testFrom).toISOString().slice(0,10)}`)
  log(SEP2)

  const header = args.testFrom
    ? `${'Agent'.padEnd(8)} ${'Mode'.padEnd(6)} ${'Period'.padEnd(6)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'CumP&L'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(7)}`
    : `${'Agent'.padEnd(8)} ${'Mode'.padEnd(6)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'CumP&L'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(7)}`
  log(header)
  log(SEP)

  function exitStats(exits) {
    if (!exits.length) return { trades: 0, winRate: '—' }
    const wins = exits.filter(e => e.pnl_pct > 0).length
    return { trades: exits.length, winRate: (wins / exits.length * 100).toFixed(0) + '%' }
  }

  for (const agent of agentPool) {
    const allExits = outDb
      ? outDb.query('exit', { agent_id: agent.id, limit: 100000, order: 'asc' })
      : []

    if (args.testFrom) {
      const trainExits = allExits.filter(e => e.timestamp < args.testFrom)
      const testExits  = allExits.filter(e => e.timestamp >= args.testFrom)
      const trainM     = calcMetrics(equity[agent.id].train, CAPITAL)
      const testM      = calcMetrics(equity[agent.id].test,  equity[agent.id].test[0]?.capital || CAPITAL)
      const trs = exitStats(trainExits), tes = exitStats(testExits)

      const fmt = (label, stats, m) => {
        const pnl = m ? (parseFloat(m.cumPnl) >= 0 ? '+' : '') + m.cumPnl + '%' : '—'
        const sh  = m ? m.sharpe : '—'
        const dd  = m ? '-' + m.maxDd + '%' : '—'
        const wr  = stats.trades ? stats.winRate : '—'
        const tr  = stats.trades || '—'
        log(`${agent.id.padEnd(8)} ${agent.mode.padEnd(6)} ${label.padEnd(6)} ${String(tr).padStart(7)} ${String(wr).padStart(8)} ${String(pnl).padStart(8)} ${String(sh).padStart(7)} ${String(dd).padStart(7)}`)
      }
      fmt('train', trs, trainM)
      fmt('test ', tes, testM)
    } else {
      const m   = calcMetrics(equity[agent.id].train, CAPITAL)
      const sts = exitStats(allExits)
      const pnl = m ? (parseFloat(m.cumPnl) >= 0 ? '+' : '') + m.cumPnl + '%' : '—'
      const sh  = m ? m.sharpe : '—'
      const dd  = m ? '-' + m.maxDd + '%' : '—'
      log(`${agent.id.padEnd(8)} ${agent.mode.padEnd(6)} ${String(sts.trades).padStart(7)} ${String(sts.trades ? sts.winRate : '—').padStart(8)} ${String(pnl).padStart(8)} ${String(sh).padStart(7)} ${String(dd).padStart(7)}`)
    }
  }

  log(SEP)
  log('')
  log('Sharpe > 1.0 = acceptable  |  > 1.5 = good  |  > 2.0 = strong')
  log('MaxDD  < 10% = conservative  |  < 20% = acceptable')
  log('')

  srcDb.close()
  if (outDb) { outDb.close(); log(`events written to ${args.out}`) }
}

main().catch(err => { log('error:', err.message); process.exit(1) })

