'use strict'

// tools/optimize.js — Parameter grid search / random search optimizer.
//
// Loads backtest.db once, precomputes all signal vectors (including 4h macro
// regime), then runs hundreds of config combinations in-memory with no file I/O.
// Ranks results by test-period Sharpe. Optionally saves the best config.
//
// Usage:
//   node tools/optimize.js                                       # 500 samples, auto split
//   node tools/optimize.js --src ./data/backtest-bull.db        # use bull-run data
//   node tools/optimize.js --test-from 2024-12-01               # explicit test split
//   node tools/optimize.js --samples 1000                       # more samples
//   node tools/optimize.js --top 20                             # show top 20
//   node tools/optimize.js --out ./data/configs-bt/agent-A1.json  # save best config

require('dotenv').config()

const fs         = require('fs')
const Database   = require('better-sqlite3')
const Agent      = require('../core/agent')
const { classifyRegime } = require('../core/regime')

const FOUR_H_MS = 4 * 60 * 60 * 1000
const CAPITAL   = parseFloat(process.env.INITIAL_CAPITAL) || 5000

const log = (...a) => process.stdout.write(a.join(' ') + '\n')

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    src:      './data/backtest.db',
    testFrom: null,
    samples:  500,
    top:      15,
    out:      null,
    seed:     null
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src'       && argv[i+1]) { args.src      = argv[++i];                           continue }
    if (argv[i] === '--test-from' && argv[i+1]) { args.testFrom = new Date(argv[++i]).getTime();       continue }
    if (argv[i] === '--samples'   && argv[i+1]) { args.samples  = parseInt(argv[++i]);                 continue }
    if (argv[i] === '--top'       && argv[i+1]) { args.top      = parseInt(argv[++i]);                 continue }
    if (argv[i] === '--out'       && argv[i+1]) { args.out      = argv[++i];                           continue }
    if (argv[i] === '--seed'      && argv[i+1]) { args.seed     = parseInt(argv[++i]);                 continue }
  }
  return args
}

// ── Parameter space ───────────────────────────────────────────────────────────
//
// Each key maps to a list of candidate values.
// Random search draws one value per key for each sample.

const PARAM_SPACE = {
  // ── Entry thresholds (per regime) ──────────────────────────────────────────
  threshold_trending_up:    [0.10, 0.12, 0.15, 0.20, 0.25],
  threshold_volatile:       [0.30, 0.50, 0.70, 0.90],
  threshold_trending_down:  [0.80, 0.95, 0.99],
  threshold_ranging:        [0.50, 0.70, 0.85, 0.99],

  // ── Signal weights (named profiles — too many combinations for full grid) ──
  weight_profile: [
    'cvd_heavy',      // cvd=0.40 fund=0.35 — current baseline
    'flow_moderate',  // cvd=0.25 fund=0.25 mom4h=0.20 mom1h=0.15
    'momentum',       // mom4h=0.35 mom1h=0.25 cvd=0.10 fund=0.10
    'funding_heavy',  // fund=0.50 cvd=0.20 mom4h=0.10 mom1h=0.10
    'equal',          // all signals equal weight
    'cvd_only',       // cvd=0.65 fund=0.20 — pure order flow
  ],

  // ── CVD entry gate ─────────────────────────────────────────────────────────
  // 'dip'       = mean-reversion: require cvd ≤ 0 (buying selling pressure)
  // 'neutral'   = require cvd ≥ -0.1  (slightly negative OK)
  // 'positive'  = require cvd ≥ 0     (only enter on net buying)
  // 'none'      = no CVD gate
  cvd_mode: ['dip', 'neutral', 'positive', 'none'],

  // ── Stop loss / take profit ────────────────────────────────────────────────
  stop_loss_pct:    [3, 5, 7, 10],
  take_profit_pct:  [5, 8, 10, 14],

  // ── Sell signal sensitivity ────────────────────────────────────────────────
  sell_signal: [-0.15, -0.20, -0.30, -0.40],

  // ── Timing ────────────────────────────────────────────────────────────────
  min_signal_hold_rounds: [0, 4, 8, 12],
  deadweight_rounds_min:  [8, 10, 14, 20],

  // ── Macro trend filter ────────────────────────────────────────────────────
  macro_trend_min: [0, 0.30, 0.50, 0.70],
}

// ── Weight profiles ───────────────────────────────────────────────────────────

const WEIGHT_PROFILES = {
  cvd_heavy: {
    cvd_norm: 0.40, funding_signal: 0.35,
    momentum_1h: 0.05, momentum_4h: 0.05, rsi_norm: 0.03,
    volume_zscore: 0.05, fear_greed_signal: 0.02, news_signal: 0.05
  },
  flow_moderate: {
    cvd_norm: 0.25, funding_signal: 0.25,
    momentum_1h: 0.15, momentum_4h: 0.20, rsi_norm: 0.05,
    volume_zscore: 0.05, fear_greed_signal: 0.02, news_signal: 0.03
  },
  momentum: {
    cvd_norm: 0.10, funding_signal: 0.10,
    momentum_1h: 0.25, momentum_4h: 0.35, rsi_norm: 0.08,
    volume_zscore: 0.05, fear_greed_signal: 0.04, news_signal: 0.03
  },
  funding_heavy: {
    cvd_norm: 0.20, funding_signal: 0.50,
    momentum_1h: 0.08, momentum_4h: 0.10, rsi_norm: 0.04,
    volume_zscore: 0.03, fear_greed_signal: 0.02, news_signal: 0.03
  },
  equal: {
    cvd_norm: 0.14, funding_signal: 0.14,
    momentum_1h: 0.14, momentum_4h: 0.14, rsi_norm: 0.14,
    volume_zscore: 0.14, fear_greed_signal: 0.14, news_signal: 0.02
  },
  cvd_only: {
    cvd_norm: 0.65, funding_signal: 0.20,
    momentum_1h: 0.04, momentum_4h: 0.04, rsi_norm: 0.02,
    volume_zscore: 0.02, fear_greed_signal: 0.01, news_signal: 0.02
  }
}

// ── Build agent config from sampled params ────────────────────────────────────

function buildConfig(params) {
  const weights = WEIGHT_PROFILES[params.weight_profile]

  // CVD gate settings
  let cvdDipRequired = false, cvdDipMax = 0, cvdBuyMin = -0.1
  if (params.cvd_mode === 'dip')      { cvdDipRequired = true;  cvdDipMax =  0.0; cvdBuyMin = -0.50 }
  if (params.cvd_mode === 'neutral')  { cvdDipRequired = false; cvdBuyMin = -0.10 }
  if (params.cvd_mode === 'positive') { cvdDipRequired = false; cvdBuyMin =  0.00 }
  if (params.cvd_mode === 'none')     { cvdDipRequired = false; cvdBuyMin = -1.00 }

  return {
    weights,
    entry: {
      buy_signal_base: 0.15,
      buy_signal_per_regime: {
        volatile:      params.threshold_volatile,
        trending_up:   params.threshold_trending_up,
        trending_down: params.threshold_trending_down,
        ranging:       params.threshold_ranging,
      },
      cvd_buy_min:            cvdBuyMin,
      cvd_dip_required:       cvdDipRequired,
      cvd_dip_max:            cvdDipMax,
      funding_buy_max:        0.75,
      trending_down_max_prob: 0.30,
      ranging_max_prob:       0.50,
      volatile_max_prob:      0.60,
      use_macro_regime:       true,
      macro_trend_min:        params.macro_trend_min > 0 ? params.macro_trend_min : undefined,
    },
    exit: {
      sell_signal:                   params.sell_signal,
      cvd_sell_max:                 -0.25,
      sell_loss_pct_base:            params.stop_loss_pct,
      sell_loss_pct_trending_down:   Math.max(2, Math.floor(params.stop_loss_pct / 2)),
      sell_profit_pct:               params.take_profit_pct,
      take_profit_requires_cvd_turn: false,
    },
    sizing: {
      buy_size_pct_base: 0.20,
      max_positions:     3,
      cash_min_pct:      0.25,
    },
    hold: {
      deadweight_rounds_min:    params.deadweight_rounds_min,
      deadweight_pnl_threshold: 2,
      min_hold_rounds:          4,
      min_signal_hold_rounds:   params.min_signal_hold_rounds,
    },
    kelly: {
      kelly_min_trades:    7,
      kelly_cap_multiplier: 2,
    }
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function calcMetrics(exits, equitySnaps, startCapital) {
  const trades = exits.length
  if (trades === 0) return { trades: 0, sharpe: -99, winRate: 0, maxDd: 0, cumPnl: 0 }

  const wins    = exits.filter(e => e > 0).length
  const winRate = wins / trades

  // Annualised Sharpe from daily equity snapshots
  let sharpe = 0
  if (equitySnaps.length >= 3) {
    const ret = []
    for (let i = 1; i < equitySnaps.length; i++) {
      ret.push((equitySnaps[i] - equitySnaps[i-1]) / equitySnaps[i-1])
    }
    const mean = ret.reduce((s, v) => s + v, 0) / ret.length
    const variance = ret.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, ret.length - 1)
    const std = Math.sqrt(variance)
    sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(252)
  }

  // Max drawdown from equity curve
  let peak = startCapital, maxDd = 0
  for (const cap of equitySnaps) {
    if (cap > peak) peak = cap
    const dd = (peak - cap) / peak
    if (dd > maxDd) maxDd = dd
  }

  const finalCap = equitySnaps.length > 0 ? equitySnaps[equitySnaps.length - 1] : startCapital
  return { trades, sharpe, winRate, maxDd, cumPnl: (finalCap - startCapital) / startCapital }
}

// ── Run a single in-memory replay for one config ──────────────────────────────

function runPass(candles, config, testFromTs) {
  const agent = new Agent({ id: 'OPT', mode: 'live', config, capital: CAPITAL, configVersion: 0 })

  const trainPnl   = [], testPnl   = []
  const trainEquity = [], testEquity = []
  let candleCount = 0

  for (const { timestamp, signals, prices } of candles) {
    candleCount++
    const inTest = testFromTs && timestamp >= testFromTs

    for (const action of agent.decide(signals, prices)) {
      if (action.type === 'EXIT') {
        if (inTest) testPnl.push(action.pnl_pct)
        else        trainPnl.push(action.pnl_pct)
      }
    }

    // Sample equity every 96 candles (~1 day at 15m)
    if (candleCount % 96 === 0) {
      const snap = agent.snapshot(prices)
      if (inTest) testEquity.push(snap.capital)
      else        trainEquity.push(snap.capital)
    }
  }

  return {
    train: calcMetrics(trainPnl, trainEquity, CAPITAL),
    test:  calcMetrics(testPnl,  testEquity,  CAPITAL),
  }
}

// ── Simple seeded PRNG (mulberry32) ──────────────────────────────────────────

function makePrng(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)
  const rand = makePrng(args.seed ?? Date.now())

  // ── Load ticks ──────────────────────────────────────────────────────────────

  log(`\nloading ticks from ${args.src}...`)
  let db
  try { db = new Database(args.src, { readonly: true }) }
  catch { log('ERROR: cannot open', args.src, '— run backfill first'); process.exit(1) }

  const allTicks = db.prepare('SELECT * FROM ticks ORDER BY timestamp ASC').all()
  db.close()

  if (!allTicks.length) { log('no ticks found'); process.exit(1) }
  log(`${allTicks.length} tick rows  (${new Date(allTicks[0].timestamp).toISOString().slice(0,10)} → ${new Date(allTicks[allTicks.length-1].timestamp).toISOString().slice(0,10)})`)

  // ── Auto train/test split (default: last 30% as test) ──────────────────────

  if (!args.testFrom) {
    const timestamps = [...new Set(allTicks.map(t => t.timestamp))].sort((a, b) => a - b)
    args.testFrom = timestamps[Math.floor(timestamps.length * 0.70)]
  }
  log(`train → ${new Date(args.testFrom).toISOString().slice(0,10)}   test ← ${new Date(args.testFrom).toISOString().slice(0,10)}`)

  // ── Precompute candles (signal vectors + 4h macro regime) ──────────────────
  //
  // Done once before the optimization loop. Each candle entry stores
  // the fully-built signal vector array and price map — the optimization
  // runs just call agent.decide(signals, prices) without any recomputation.

  log('\nprecomputing signal vectors...')

  const hist4h     = {}
  const lastBdry4h = {}
  const candleMap  = new Map()

  for (const tick of allTicks) {
    if (!candleMap.has(tick.timestamp)) candleMap.set(tick.timestamp, [])
    candleMap.get(tick.timestamp).push(tick)
  }

  const candles = []
  for (const [timestamp, ticks] of [...candleMap.entries()].sort((a, b) => a[0] - b[0])) {
    // Update per-pair 4h boundary buffers
    for (const t of ticks) {
      const bdry = Math.floor(timestamp / FOUR_H_MS) * FOUR_H_MS
      if (bdry !== lastBdry4h[t.pair]) {
        lastBdry4h[t.pair] = bdry
        if (!hist4h[t.pair]) hist4h[t.pair] = []
        hist4h[t.pair].push(t.mid)
        if (hist4h[t.pair].length > 30) hist4h[t.pair].shift()
      }
    }

    const prices  = {}
    const signals = ticks.map(t => {
      prices[t.pair] = t.mid
      const macro4h = classifyRegime([...(hist4h[t.pair] || [])], '4h')
      return {
        pair:                  t.pair,
        price:                 t.mid,
        cvd_norm:              t.cvd_norm           ?? 0,
        funding_signal:        t.funding_signal      ?? 0,
        momentum_1h:           t.momentum_1h         ?? 0,
        momentum_4h:           t.momentum_4h         ?? 0,
        rsi_norm:              t.rsi_norm            ?? 0,
        volume_zscore:         t.volume_zscore       ?? 0,
        fear_greed_signal:     t.fear_greed_signal   ?? 0,
        news_signal:           0,
        signal_uncertainty:    t.signal_uncertainty  ?? 0,
        p_volatile:            t.p_volatile          ?? 0.25,
        p_trending_up:         t.p_trending_up       ?? 0.25,
        p_trending_down:       t.p_trending_down     ?? 0.25,
        p_ranging:             t.p_ranging           ?? 0.25,
        macro_p_volatile:      macro4h.p_volatile,
        macro_p_trending_up:   macro4h.p_trending_up,
        macro_p_trending_down: macro4h.p_trending_down,
        macro_p_ranging:       macro4h.p_ranging,
      }
    })

    candles.push({ timestamp, signals, prices })
  }

  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)
  log(`${candles.length} candles ready  (${heapMB} MB heap)`)

  // ── Random search ──────────────────────────────────────────────────────────

  const paramKeys = Object.keys(PARAM_SPACE)

  function sampleParams() {
    const p = {}
    for (const key of paramKeys) {
      const vals = PARAM_SPACE[key]
      p[key] = vals[Math.floor(rand() * vals.length)]
    }
    return p
  }

  log(`\nrunning ${args.samples} random samples...`)

  const results     = []
  const t0          = Date.now()
  const BAR_WIDTH   = 40

  for (let i = 0; i < args.samples; i++) {
    const params  = sampleParams()
    const config  = buildConfig(params)
    const metrics = runPass(candles, config, args.testFrom)
    results.push({ params, config, ...metrics })

    // Progress bar
    if ((i + 1) % Math.max(1, Math.floor(args.samples / BAR_WIDTH)) === 0 || i === args.samples - 1) {
      const pct     = (i + 1) / args.samples
      const filled  = Math.round(pct * BAR_WIDTH)
      const bar     = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
      const elapsed = (Date.now() - t0) / 1000
      const eta     = elapsed / (i + 1) * (args.samples - i - 1)
      process.stdout.write(`\r  [${bar}] ${(pct * 100).toFixed(0).padStart(3)}%  ${(i+1).toString().padStart(4)}/${args.samples}  eta ${eta.toFixed(0)}s   `)
    }
  }
  log('\n')

  // ── Rank and display ───────────────────────────────────────────────────────

  // Sort: test Sharpe primary, test win rate secondary; penalise < 5 test trades
  results.sort((a, b) => {
    const aOk = a.test.trades >= 5
    const bOk = b.test.trades >= 5
    if (aOk !== bOk) return bOk ? 1 : -1
    if (Math.abs(b.test.sharpe - a.test.sharpe) > 0.05) return b.test.sharpe - a.test.sharpe
    return b.test.winRate - a.test.winRate
  })

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const rate    = (args.samples / elapsed).toFixed(0)

  const SEP  = '─'.repeat(116)
  const SEP2 = '═'.repeat(116)

  log(SEP2)
  log(`  OPTIMIZE RESULTS   ${args.samples} samples   ${elapsed}s   ${rate} samples/sec`)
  log(`  source: ${args.src}`)
  log(`  train: ${new Date(allTicks[0].timestamp).toISOString().slice(0,10)} → ${new Date(args.testFrom).toISOString().slice(0,10)}   test: ${new Date(args.testFrom).toISOString().slice(0,10)} → ${new Date(allTicks[allTicks.length-1].timestamp).toISOString().slice(0,10)}`)
  log(SEP2)
  log('')
  log(
    `${'#'.padStart(3)}  ` +
    `${'TstSharpe'.padStart(9)}  ${'TstWin'.padStart(6)}  ${'TstPnL'.padStart(7)}  ${'TstDD'.padStart(6)}  ${'TstN'.padStart(4)}  ` +
    `${'TrSharpe'.padStart(8)}  ${'TrWin'.padStart(5)}  ${'TrN'.padStart(4)}  ` +
    `${'StopL'.padStart(5)}  ${'TP'.padStart(4)}  ${'Sell'.padStart(5)}  ` +
    `${'↑thr'.padStart(5)}  ${'vthr'.padStart(5)}  ${'rthr'.padStart(5)}  ` +
    `${'SigHld'.padStart(6)}  ${'DWT'.padStart(3)}  ${'MacMin'.padStart(6)}  ${'CVD'.padStart(8)}  ${'Weights'.padStart(13)}`
  )
  log(SEP)

  let printed = 0
  for (const r of results) {
    if (printed >= args.top) break
    const { test: ts, train: tr, params: p } = r

    if (ts.trades < 5) continue  // not enough test trades for meaningful Sharpe

    const s = v => v >= 0 ? '+' + v.toFixed(2) : v.toFixed(2)

    log(
      `${String(printed + 1).padStart(3)}  ` +
      `${s(ts.sharpe).padStart(9)}  ${(ts.winRate * 100).toFixed(0).padStart(5)}%  ` +
      `${((ts.cumPnl >= 0 ? '+' : '') + (ts.cumPnl * 100).toFixed(1) + '%').padStart(7)}  ` +
      `${('-' + (ts.maxDd * 100).toFixed(1) + '%').padStart(6)}  ` +
      `${String(ts.trades).padStart(4)}  ` +
      `${s(tr.sharpe).padStart(8)}  ${(tr.winRate * 100).toFixed(0).padStart(4)}%  ${String(tr.trades).padStart(4)}  ` +
      `${(p.stop_loss_pct + '%').padStart(5)}  ${(p.take_profit_pct + '%').padStart(4)}  ` +
      `${String(p.sell_signal).padStart(5)}  ` +
      `${String(p.threshold_trending_up).padStart(5)}  ` +
      `${String(p.threshold_volatile).padStart(5)}  ` +
      `${String(p.threshold_ranging).padStart(5)}  ` +
      `${String(p.min_signal_hold_rounds + 'r').padStart(6)}  ` +
      `${String(p.deadweight_rounds_min).padStart(3)}  ` +
      `${String(p.macro_trend_min).padStart(6)}  ` +
      `${p.cvd_mode.padStart(8)}  ` +
      `${p.weight_profile.padStart(13)}`
    )
    printed++
  }
  log(SEP)

  // ── Legend ────────────────────────────────────────────────────────────────

  log('')
  log('Columns: TstSharpe/TrSharpe = annualised Sharpe   TstPnL = cumulative P&L on test period')
  log('         ↑thr = threshold_trending_up   vthr = volatile   rthr = ranging')
  log('         SigHld = min_signal_hold_rounds   DWT = deadweight_rounds_min')
  log('         MacMin = macro_trend_min   CVD = cvd entry mode')
  log('')
  log('Interpretation:')
  log('  Sharpe > 0  = test period profitable   > 1.0 = strong edge')
  log('  Look for: TstSharpe ↑  AND  TstDD ↓  AND  TstN ≥ 10 (enough trades to be reliable)')
  log('  Ignore results with TstN < 10 — too few test trades for statistical significance')
  log('')

  // ── Best config details + save ─────────────────────────────────────────────

  const best = results.find(r => r.test.trades >= 5)
  if (!best) { log('no results with enough test trades'); return }

  log('─── BEST CONFIG ──────────────────────────────────────────────────────────────')
  log('')
  log('Parameters:')
  for (const [k, v] of Object.entries(best.params)) {
    log(`  ${k.padEnd(28)} ${v}`)
  }
  log('')
  log(`Train: Sharpe=${best.train.sharpe.toFixed(2)}  Win=${(best.train.winRate*100).toFixed(0)}%  PnL=${(best.train.cumPnl*100).toFixed(1)}%  MaxDD=${(best.train.maxDd*100).toFixed(1)}%  Trades=${best.train.trades}`)
  log(`Test:  Sharpe=${best.test.sharpe.toFixed(2)}  Win=${(best.test.winRate*100).toFixed(0)}%  PnL=${(best.test.cumPnl*100).toFixed(1)}%  MaxDD=${(best.test.maxDd*100).toFixed(1)}%  Trades=${best.test.trades}`)
  log('')

  if (args.out) {
    const output = {
      version: 1,
      config:  best.config,
      reason:  `optimize: test_sharpe=${best.test.sharpe.toFixed(2)} test_win=${(best.test.winRate*100).toFixed(0)}% test_pnl=${(best.test.cumPnl*100).toFixed(1)}%`,
      _optimize_params: best.params,
      _optimize_metrics: { train: best.train, test: best.test }
    }
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2))
    log(`saved best config → ${args.out}`)
  } else {
    log('Tip: re-run with --out ./data/configs-bt/agent-A1.json to save the best config')
  }

  log(`\nTotal: ${elapsed}s for ${args.samples} samples  (${rate}/sec)`)
}

main().catch(err => { log('\nERROR:', err.message, '\n' + err.stack); process.exit(1) })
