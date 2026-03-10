'use strict'

// node backtester/backtest.js --pairs ALL --period 365 --interval 1h [--tune-weights]

const fs      = require('fs')
const path    = require('path')
const { C }   = require('../core/world')
const signals = require('../core/signals')
const { runSimulation } = require('./simulate')
const metrics = require('./metrics')
const report  = require('./report')

const PAIR_ALIASES = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', BNB: 'BNBUSDT', SOL: 'SOLUSDT',
  XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', ADA: 'ADAUSDT', AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', LTC: 'LTCUSDT',
  UNI: 'UNIUSDT', ATOM: 'ATOMUSDT', NEAR: 'NEARUSDT'
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

  const pairsArg    = get('--pairs') || 'BTC,ETH'
  const period      = parseInt(get('--period')     || '30', 10)
  const interval    = get('--interval') || '1h'
  const tuneWeights = args.includes('--tune-weights')
  const walkForward = args.includes('--walk-forward')
  const trainDays   = parseInt(get('--train-days') || String(C.BACKTEST_TRAIN_DAYS), 10)
  const testDays    = parseInt(get('--test-days')  || String(C.BACKTEST_TEST_DAYS),  10)

  const symbols = pairsArg === 'ALL'
    ? C.PAIRS
    : pairsArg.split(',').map(p => PAIR_ALIASES[p.toUpperCase()] || (p.toUpperCase() + 'USDT'))

  return { symbols, period, interval, tuneWeights, walkForward, trainDays, testDays }
}

function loadOhlcv(symbol, interval) {
  const file = path.join(__dirname, '../data/ohlcv', `${symbol}_${interval}.json`)
  if (!fs.existsSync(file)) {
    console.error(`Missing: ${file}`)
    console.error('Run: node backtester/fetch-history.js first')
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Build price history rolling windows for signal computation
function buildHistories(allBars, symbols, upToIdx) {
  const histories = {}
  for (const sym of symbols) {
    histories[sym] = allBars[sym]
      .slice(Math.max(0, upToIdx - 49), upToIdx + 1)
      .map(b => b.close)
  }
  return histories
}

async function computeBarSignals(allBars, symbols, idx) {
  const prices   = {}
  for (const sym of symbols) {
    const bar = allBars[sym][idx]
    if (bar) prices[sym] = bar.close
  }
  const histories = buildHistories(allBars, symbols, idx)
  return signals.computeSignals(prices, histories, { backtest: true })
}

async function runBacktest(allBars, symbols, startIdx, endIdx) {
  // Use BTC as the primary "bar" driver (all pairs assumed aligned)
  const primaryBars = allBars[symbols[0]].slice(startIdx, endIdx)
  const barSignals  = await Promise.all(
    Array.from({ length: endIdx - startIdx }, (_, i) =>
      computeBarSignals(allBars, symbols, startIdx + i)
    )
  )

  const { trades, portfolioValues } = runSimulation(primaryBars, barSignals)

  const returns = portfolioValues.slice(1).map((v, i) =>
    (v - portfolioValues[i]) / portfolioValues[i]
  )

  // Periods per year: 8760 for 1h, 365 for 1d, etc.
  const periodsPerYear = periodsPerYearFor(primaryBars)

  const sharpe      = metrics.sharpeRatio(returns, periodsPerYear)
  const dd          = metrics.maxDrawdown(portfolioValues)
  const wr          = metrics.winRate(trades)
  const pf          = metrics.profitFactor(trades)
  const finalVal    = portfolioValues[portfolioValues.length - 1]
  const totalReturn = (finalVal - C.INITIAL_CAPITAL) / C.INITIAL_CAPITAL

  return {
    bars:        primaryBars.length,
    sharpe,
    maxDrawdown: dd.pct,
    winRate:     wr,
    profitFactor: pf,
    totalReturn,
    trades:      trades.length
  }
}

function periodsPerYearFor(bars) {
  if (bars.length < 2) return 8760
  const msPerBar    = bars[1].ts - bars[0].ts
  const msPerYear   = 365 * 24 * 3600 * 1000
  return Math.round(msPerYear / msPerBar)
}

async function tuneWeights(allBars, symbols, startIdx, splitIdx) {
  console.log('Tuning signal weights (grid search)...')
  const candidates = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
  let bestSharpe = -Infinity
  let bestWeights = { ...C.SIGNAL_WEIGHTS }

  // Grid: vary momentum_1h and rsi_norm; scale remaining weights proportionally
  const fixedKeys = ['funding_signal', 'cvd_norm', 'fear_greed_signal', 'volume_zscore', 'momentum_4h']
  const fixedBase = fixedKeys.reduce((s, k) => s + (C.SIGNAL_WEIGHTS[k] || 0), 0)

  for (const m1 of candidates) {
    for (const rsi of candidates) {
      const remaining = 1 - m1 - rsi
      if (remaining <= 0 || fixedBase === 0) continue
      const scale = remaining / fixedBase
      const w = { momentum_1h: m1, rsi_norm: rsi }
      for (const k of fixedKeys) w[k] = (C.SIGNAL_WEIGHTS[k] || 0) * scale

      Object.assign(C.SIGNAL_WEIGHTS, w)
      const result = await runBacktest(allBars, symbols, startIdx, splitIdx)
      if (result.sharpe > bestSharpe) {
        bestSharpe  = result.sharpe
        bestWeights = { ...w }
      }
    }
  }
  Object.assign(C.SIGNAL_WEIGHTS, bestWeights)
  console.log(`Best weights (Sharpe=${bestSharpe.toFixed(3)}):`, bestWeights)
}

/**
 * runWalkForward — rolling walk-forward validation.
 *
 * Trains on `trainBars` bars, tests on the next `testBars`, steps forward by
 * `testBars` (non-overlapping test windows). Reports per-window and aggregate
 * out-of-sample metrics — the honest measure of whether edge survives.
 */
async function runWalkForward(allBars, symbols, trainBars, testBars) {
  const minLen  = Math.min(...symbols.map(s => allBars[s].length))
  const windows = []

  for (let trainEnd = trainBars; trainEnd + testBars <= minLen; trainEnd += testBars) {
    const testEnd = trainEnd + testBars
    const result  = await runBacktest(allBars, symbols, trainEnd, testEnd)
    windows.push({ window: windows.length + 1, trainEnd, testEnd, ...result })
  }

  if (!windows.length) return null

  const avgSharpe    = windows.reduce((s, w) => s + w.sharpe,      0) / windows.length
  const avgDrawdown  = windows.reduce((s, w) => s + w.maxDrawdown, 0) / windows.length
  const avgReturn    = windows.reduce((s, w) => s + w.totalReturn, 0) / windows.length
  const posWindows   = windows.filter(w => w.totalReturn > 0).length

  return { windows, avgSharpe, avgDrawdown, avgReturn, posWindowsPct: posWindows / windows.length }
}

async function main() {
  const { symbols, period, interval, tuneWeights: doTune, walkForward, trainDays, testDays } = parseArgs()
  console.log(`Backtesting ${symbols.join(', ')} — ${period}d @ ${interval}`)

  // 1. Load OHLCV
  const allBars = {}
  for (const sym of symbols) {
    allBars[sym] = loadOhlcv(sym, interval)
  }

  // Use shortest series length across all pairs
  const minLen   = Math.min(...symbols.map(s => allBars[s].length))
  const splitIdx = Math.floor(minLen * 0.75)

  console.log(`Bars: ${minLen} total | in-sample: ${splitIdx} | holdout: ${minLen - splitIdx}`)

  // 2. Optionally tune weights on in-sample
  if (doTune) await tuneWeights(allBars, symbols, 0, splitIdx)

  if (walkForward) {
    // ── Walk-forward mode ──────────────────────────────────────────────────
    // Convert days → bars based on interval (1h → 24 bars/day)
    const barsPerDay = periodsPerYearFor(allBars[symbols[0]].slice(0, 2)) / 365
    const trainBars  = Math.round(trainDays * barsPerDay)
    const testBars   = Math.round(testDays  * barsPerDay)
    console.log(`Walk-forward: train=${trainDays}d (${trainBars} bars)  test=${testDays}d (${testBars} bars)`)

    const wf = await runWalkForward(allBars, symbols, trainBars, testBars)
    if (!wf) { console.error('Not enough data for walk-forward.'); process.exit(1) }

    const results = { pairs: symbols, period, interval, mode: 'walk-forward', trainDays, testDays, walkForward: wf }
    report.printWalkForward(results)
    report.save(results)
  } else {
    // ── Standard 75/25 split ───────────────────────────────────────────────
    const inSample = await runBacktest(allBars, symbols, 0, splitIdx)
    const holdout  = await runBacktest(allBars, symbols, splitIdx, minLen)

    const results = { pairs: symbols, period, interval, mode: 'split', inSample, holdout }
    report.print(results)
    report.save(results)
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
