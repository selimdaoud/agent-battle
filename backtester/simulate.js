'use strict'

const { C } = require('../core/world')

/**
 * simulateTick(bar, signalVector, agentState) → { action, pair, amount_usd }
 *
 * agentState: { capital, holdings: { [pair]: qty }, entryPrices: { [pair]: price } }
 * Mutates agentState in place and returns the decision taken.
 */
function simulateTick(bar, signal, agentState) {
  const { pair, signal_score } = signal
  const price     = bar.close
  const capital   = agentState.capital
  const holdings  = agentState.holdings
  const positions = Object.values(holdings).filter(q => q > 0).length

  let decision = { action: 'HOLD', pair, amount_usd: 0 }

  if (signal_score > 0.4 && capital > 500 && positions < C.MAX_POSITIONS) {
    const amount = capital * 0.20
    decision = { action: 'BUY', pair, amount_usd: amount }
  } else if (signal_score < -0.4 && (holdings[pair] || 0) > 0) {
    const qty     = holdings[pair]
    decision = { action: 'SELL', pair, amount_usd: qty * price }
  }

  // Apply same risk limits as world.applyDecision
  decision = enforceRisk(decision, agentState, price)

  // Execute trade
  if (decision.action === 'BUY' && decision.amount_usd > 0) {
    const cost = decision.amount_usd * (1 + C.SLIPPAGE_PCT)
    const qty  = decision.amount_usd / price
    agentState.capital       -= cost
    holdings[pair]            = (holdings[pair] || 0) + qty
    agentState.entryPrices[pair] = price
  } else if (decision.action === 'SELL') {
    const qty     = holdings[pair] || 0
    if (qty > 0) {
      const proceeds            = qty * price * (1 - C.SLIPPAGE_PCT)
      agentState.capital       += proceeds
      holdings[pair]            = 0
      delete agentState.entryPrices[pair]
    }
  }

  return decision
}

function enforceRisk(decision, agentState, price) {
  const total    = portfolioValue(agentState, { [decision.pair]: price })
  const capital  = agentState.capital
  const holdings = agentState.holdings

  if (decision.action === 'BUY') {
    decision.amount_usd = Math.min(decision.amount_usd, capital * 0.95)
    decision.amount_usd = Math.min(decision.amount_usd, total * C.MAX_POSITION_PCT)
    const invested = total - capital
    if (total > 0 && invested / total >= C.MAX_EXPOSURE_PCT) {
      return { ...decision, action: 'HOLD', amount_usd: 0 }
    }
  }
  return decision
}

function portfolioValue(agentState, prices) {
  let val = agentState.capital
  for (const [pair, qty] of Object.entries(agentState.holdings)) {
    if (qty > 0 && prices[pair]) val += qty * prices[pair]
  }
  return val
}

/**
 * runSimulation(bars, signals) → { trades, portfolioValues }
 *
 * bars:    array of { ts, open, high, low, close, volume }
 * signals: array of SignalVector (one per bar, same length)
 */
function runSimulation(bars, signals) {
  const agentState = {
    capital:     C.INITIAL_CAPITAL,
    holdings:    {},
    entryPrices: {}
  }

  const trades          = []
  const portfolioValues = [C.INITIAL_CAPITAL]

  for (let i = 0; i < bars.length; i++) {
    const bar    = bars[i]
    const sigArr = signals[i]  // array of SignalVector for this bar

    // Pick the signal with the highest absolute signal_score to trade
    const best = sigArr.reduce((a, b) =>
      Math.abs(b.signal_score) > Math.abs(a.signal_score) ? b : a, sigArr[0])

    if (!best) { portfolioValues.push(agentState.capital); continue }

    const prices = {}
    for (const s of sigArr) prices[s.pair] = s.price

    const decision = simulateTick(bar, best, agentState)

    if (decision.action !== 'HOLD') {
      trades.push({
        ts:          bar.ts,
        action:      decision.action,
        pair:        decision.pair,
        amount_usd:  decision.amount_usd,
        price:       bar.close,
        signal_score: best.signal_score
      })
    }

    portfolioValues.push(portfolioValue(agentState, prices))
  }

  return { trades, portfolioValues }
}

module.exports = { simulateTick, runSimulation, portfolioValue }
