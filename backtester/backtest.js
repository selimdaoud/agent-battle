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

  const pairsArg   = get('--pairs') || 'BTC,ETH'
  const period     = parseInt(get('--period') || '30', 10)
  const interval   = get('--interval') || '1h'
  const tuneWeights = args.includes('--tune-weights')

  const symbols = pairsArg === 'ALL'
    ? C.PAIRS
    : pairsArg.split(',').map(p => PAIR_ALIASES[p.toUpperCase()] || (p.toUpperCase() + 'USDT'))

  return { symbols, period, interval, tuneWeights }
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

function computeBarSignals(allBars, symbols, idx) {
  const prices   = {}
  for (const sym of symbols) {
    const bar = allBars[sym][idx]
    if (bar) prices[sym] = bar.close
  }
  const histories = buildHistories(allBars, symbols, idx)
  return signals.computeSignals(prices, histories)
}

function runBacktest(allBars, symbols, startIdx, endIdx) {
  // Use BTC as the primary "bar" driver (all pairs assumed aligned)
  const primaryBars = allBars[symbols[0]].slice(startIdx, endIdx)
  const barSignals  = []

  for (let i = startIdx; i < endIdx; i++) {
    barSignals.push(computeBarSignals(allBars, symbols, i))
  }

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

function tuneWeights(allBars, symbols, startIdx, splitIdx) {
  console.log('Tuning signal weights (grid search)...')
  const candidates = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
  let bestSharpe = -Infinity
  let bestWeights = { ...C.SIGNAL_WEIGHTS }

  // Simplified grid: vary momentum_1h and rsi_norm, keep rest proportional
  for (const m1 of candidates) {
    for (const rsi of candidates) {
      // Distribute remaining weight proportionally
      const remaining = 1 - m1 - rsi
      if (remaining <= 0) continue
      const scale = remaining / (C.SIGNAL_WEIGHTS.momentum_4h + C.SIGNAL_WEIGHTS.volume_zscore +
                                 C.SIGNAL_WEIGHTS.mean_rev + C.SIGNAL_WEIGHTS.btc_lead)
      const w = {
        momentum_1h:   m1,
        rsi_norm:      rsi,
        momentum_4h:   C.SIGNAL_WEIGHTS.momentum_4h   * scale,
        volume_zscore: C.SIGNAL_WEIGHTS.volume_zscore  * scale,
        mean_rev:      C.SIGNAL_WEIGHTS.mean_rev       * scale,
        btc_lead:      C.SIGNAL_WEIGHTS.btc_lead       * scale
      }
      // Temporarily swap weights
      Object.assign(C.SIGNAL_WEIGHTS, w)
      const result = runBacktest(allBars, symbols, startIdx, splitIdx)
      if (result.sharpe > bestSharpe) {
        bestSharpe  = result.sharpe
        bestWeights = { ...w }
      }
    }
  }
  Object.assign(C.SIGNAL_WEIGHTS, bestWeights)
  console.log(`Best weights (Sharpe=${bestSharpe.toFixed(3)}):`, bestWeights)
}

async function main() {
  const { symbols, period, interval, tuneWeights: doTune } = parseArgs()
  console.log(`Backtesting ${symbols.join(', ')} — ${period}d @ ${interval}`)

  // 1. Load OHLCV
  const allBars = {}
  for (const sym of symbols) {
    allBars[sym] = loadOhlcv(sym, interval)
  }

  // Use shortest series length across all pairs
  const minLen   = Math.min(...symbols.map(s => allBars[s].length))
  const splitIdx = Math.floor(minLen * 0.75)

  // 2. 75/25 split
  console.log(`Bars: ${minLen} total | in-sample: ${splitIdx} | holdout: ${minLen - splitIdx}`)

  // 3. Optionally tune weights on in-sample
  if (doTune) tuneWeights(allBars, symbols, 0, splitIdx)

  // 4. In-sample run
  const inSample = runBacktest(allBars, symbols, 0, splitIdx)

  // 5. Holdout run
  const holdout  = runBacktest(allBars, symbols, splitIdx, minLen)

  const results = { pairs: symbols, period, interval, inSample, holdout }

  // 6. Print + save
  report.print(results)
  report.save(results)
}

main().catch(err => { console.error(err.message); process.exit(1) })
