'use strict'

const ss = require('simple-statistics')
const { C } = require('./world')

// ── Helpers ───────────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return 0
  return ss.standardDeviation(arr)
}

function sma(arr, period) {
  if (arr.length < period) return mean(arr)
  return mean(arr.slice(-period))
}

// Wilder RSI (14-period)
function wilderRsi(closes, period) {
  period = period || 14
  if (closes.length < period + 1) return 50

  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains  += change
    else            losses -= change
  }

  const avgGain = gains  / period
  const avgLoss = losses / period

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

// Z-score of last return vs rolling stddev of returns
function momentumZscore(closes) {
  if (closes.length < 3) return 0
  const returns = closes.slice(1).map((v, i) => (v - closes[i]) / closes[i])
  const lastRet = returns[returns.length - 1]
  const window  = returns.slice(-20)
  const sd      = stddev(window)
  if (sd === 0) return 0
  return lastRet / sd
}

// Regime classifier — uses last 20 closes
function classifyRegime(closes) {
  if (closes.length < 10) return { regime: 'ranging', regime_confidence: 0.6 }

  const last20 = closes.slice(-20)
  const logReturns = last20.slice(1).map((v, i) => Math.log(v / last20[i]))

  const realisedVol = logReturns.length >= 2
    ? stddev(logReturns) * Math.sqrt(8760)
    : 0

  if (realisedVol > 0.80) {
    return {
      regime:            'volatile',
      regime_confidence: Math.max(0.5, Math.min(1.0, realisedVol / 0.80))
    }
  }

  // sma_slope: compare sma of last 5 vs sma of closes 6-10 from end
  const last10 = closes.slice(-10)
  const first5  = last10.slice(0, 5)
  const second5 = last10.slice(5)
  const smaFirst  = mean(first5)
  const smaSecond = mean(second5)
  const smaSlope  = smaFirst !== 0 ? (smaSecond - smaFirst) / smaFirst : 0

  // adx_proxy = mean(|returns|) / stddev(returns)
  const absRets = logReturns.map(r => Math.abs(r))
  const meanAbs = mean(absRets)
  const sdRets  = stddev(logReturns)
  const adxProxy = sdRets > 0 ? meanAbs / sdRets : 0

  if (adxProxy > 1.5 && smaSlope >= 0) {
    return {
      regime:            'trending_up',
      regime_confidence: Math.max(0.5, Math.min(1.0, adxProxy / 1.5))
    }
  }
  if (adxProxy > 1.5 && smaSlope < 0) {
    return {
      regime:            'trending_down',
      regime_confidence: Math.max(0.5, Math.min(1.0, adxProxy / 1.5))
    }
  }
  return { regime: 'ranging', regime_confidence: 0.6 }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * computeSignals(prices, priceHistories) → SignalVector[]
 *
 * prices:         { BTCUSDT: 67420, ... }
 * priceHistories: { BTCUSDT: [65000, ..., 67420], ... }  — last 50 closes
 */
function computeSignals(prices, priceHistories) {
  const signals = []

  // Compute BTC momentum_1h first (needed for btc_lead_signal on alts)
  const btcHistory = priceHistories['BTCUSDT'] || []
  const btcMom1h   = momentumZscore(btcHistory)

  for (const pair of C.PAIRS) {
    if (prices[pair] === undefined) continue

    const closes = priceHistories[pair] || []
    const price  = prices[pair]

    // ── momentum_1h ──────────────────────────────────────────────────────
    const momentum_1h = momentumZscore(closes)

    // ── momentum_4h — every-4th close as 4h proxy ────────────────────────
    const closes4h = closes.filter((_, i) => i % 4 === 0)
    const momentum_4h = momentumZscore(closes4h)

    // ── volume_zscore ─────────────────────────────────────────────────────
    // priceHistory contains only closes; no volume data available → 0
    const volume_zscore = 0

    // ── RSI ───────────────────────────────────────────────────────────────
    const rsi_14   = wilderRsi(closes, 14)
    const rsi_norm = (rsi_14 - 50) / 50

    // ── RSI divergence: price new high but RSI lower high (last 10 bars) ─
    let rsi_divergence = false
    if (closes.length >= 11) {
      const last10Closes = closes.slice(-10)
      const last10Rsis   = last10Closes.map((_, idx) =>
        wilderRsi(closes.slice(0, closes.length - 10 + idx + 1), 14)
      )
      const priceNewHigh = price > Math.max(...last10Closes.slice(0, -1))
      const rsiLowerHigh = rsi_14 < Math.max(...last10Rsis.slice(0, -1))
      rsi_divergence = priceNewHigh && rsiLowerHigh
    }

    // ── mean_rev_sigma: (price - sma20) / std20 ──────────────────────────
    const last20   = closes.slice(-20)
    const sma20    = sma(closes, 20)
    const std20    = stddev(last20)
    const mean_rev_sigma = std20 > 0 ? (price - sma20) / std20 : 0

    // ── bb_position: (price - lower_bb) / (upper_bb - lower_bb) ─────────
    const lower_bb = sma20 - 2 * std20
    const upper_bb = sma20 + 2 * std20
    const bb_range = upper_bb - lower_bb
    const bb_position = bb_range > 0 ? (price - lower_bb) / bb_range : 0.5

    // ── btc_lead_signal ───────────────────────────────────────────────────
    const btc_lead_signal = pair === 'BTCUSDT' ? null : btcMom1h

    // ── Regime ────────────────────────────────────────────────────────────
    const { regime, regime_confidence } = classifyRegime(closes)

    // ── Composite signal_score ────────────────────────────────────────────
    const w = C.SIGNAL_WEIGHTS
    const raw =
      momentum_1h                                    * w.momentum_1h  +
      momentum_4h                                    * w.momentum_4h  +
      rsi_norm                                       * w.rsi_norm     +
      Math.max(-1, Math.min(1, volume_zscore / 3))   * w.volume_zscore +
      (-mean_rev_sigma / 3)                          * w.mean_rev     +
      (btc_lead_signal || 0)                         * w.btc_lead

    const signal_score = Math.max(-1, Math.min(1,
      raw * (C.REGIME_MULTIPLIERS[regime] || 1.0)
    ))

    signals.push({
      pair,
      price,
      momentum_1h,
      momentum_4h,
      volume_zscore,
      rsi_14,
      rsi_norm,
      rsi_divergence,
      mean_rev_sigma,
      bb_position,
      btc_lead_signal,
      regime,
      regime_confidence,
      signal_score
    })
  }

  return signals
}

module.exports = { computeSignals }
