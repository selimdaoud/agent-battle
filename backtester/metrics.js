'use strict'

const ss = require('simple-statistics')

function sharpeRatio(returns, periodsPerYear) {
  if (!returns || returns.length < 2) return 0
  const mean   = ss.mean(returns)
  const stddev = ss.standardDeviation(returns)
  if (stddev === 0) return 0
  return (mean / stddev) * Math.sqrt(periodsPerYear)
}

function maxDrawdown(portfolioValues) {
  if (!portfolioValues || portfolioValues.length < 2) {
    return { pct: 0, peakIdx: 0, troughIdx: 0 }
  }
  let peak = portfolioValues[0], peakIdx = 0
  let maxDD = 0, troughIdx = 0

  for (let i = 1; i < portfolioValues.length; i++) {
    if (portfolioValues[i] > peak) {
      peak    = portfolioValues[i]
      peakIdx = i
    }
    const dd = peak > 0 ? (peak - portfolioValues[i]) / peak : 0
    if (dd > maxDD) {
      maxDD      = dd
      troughIdx  = i
    }
  }
  return { pct: maxDD, peakIdx, troughIdx }
}

function winRate(trades) {
  // Pair buys with subsequent sells to determine PnL per closed trade
  const closed = closedTrades(trades)
  if (!closed.length) return 0
  const wins = closed.filter(t => t.pnl > 0).length
  return wins / closed.length
}

function profitFactor(trades) {
  const closed     = closedTrades(trades)
  const grossProfit = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLoss   = closed.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0)
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0
  return grossProfit / grossLoss
}

function calmarRatio(annReturn, maxDD) {
  if (maxDD === 0) return annReturn > 0 ? Infinity : 0
  return annReturn / maxDD
}

function rollingSharpePct(returns, window) {
  if (!returns || returns.length < window) return []
  const result = []
  for (let i = window; i <= returns.length; i++) {
    const slice = returns.slice(i - window, i)
    result.push(sharpeRatio(slice, window))
  }
  return result
}

function signalAccuracy(decisions) {
  // decisions: [{ action, signal_score, outcome_pnl }]
  // outcome_pnl > 0 means the direction was correct
  const buys  = decisions.filter(d => d.action === 'BUY')
  const sells = decisions.filter(d => d.action === 'SELL')

  const buyAcc  = buys.length
    ? buys.filter(d => d.outcome_pnl > 0).length / buys.length
    : null
  const sellAcc = sells.length
    ? sells.filter(d => d.outcome_pnl > 0).length / sells.length
    : null

  return { buy: buyAcc, sell: sellAcc }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function closedTrades(trades) {
  // Match BUY→SELL pairs per pair
  const open   = {}  // pair → { price, amount }
  const closed = []

  for (const t of trades) {
    if (t.action === 'BUY') {
      open[t.pair] = { price: t.price, amount: t.amount_usd }
    } else if (t.action === 'SELL' && open[t.pair]) {
      const entry = open[t.pair]
      const pnl   = (t.price - entry.price) / entry.price * entry.amount
      closed.push({ pair: t.pair, pnl, entryPrice: entry.price, exitPrice: t.price })
      delete open[t.pair]
    }
  }
  return closed
}

module.exports = {
  sharpeRatio,
  maxDrawdown,
  winRate,
  profitFactor,
  calmarRatio,
  rollingSharpePct,
  signalAccuracy
}
