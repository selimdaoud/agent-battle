'use strict'

// ── Math helpers ──────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1))
}

// Logistic function — maps any real number to (0, 1)
// k controls steepness: higher k = sharper boundary
function logistic(x, k = 4) {
  return 1 / (1 + Math.exp(-k * x))
}

// ── Bars per year (for annualised vol) ────────────────────────────────────────

const BARS_PER_YEAR = {
  '1m': 525600, '3m': 175200, '5m': 105120,
  '15m': 35040, '30m': 17520,
  '1h': 8760,   '2h': 4380,   '4h': 2190,
  '1d': 365,    '1w': 52
}

// ── Regime classifier ─────────────────────────────────────────────────────────

/**
 * classifyRegime(closes, interval) → { p_volatile, p_trending_up, p_trending_down, p_ranging }
 *
 * Probabilities sum to 1.0. Uses the same three inputs as v1 but outputs a
 * continuous distribution instead of a discrete label.
 *
 * The v1 thresholds (vol > 0.80, adxProxy > 1.1, |smaSlope| > 0.003) are
 * preserved as the inflection points of each logistic curve — a value exactly
 * at a boundary produces p ≈ 0.50 for each adjacent state. Values deep inside
 * a regime produce p ≈ 1.0 for that regime.
 *
 * Effective threshold for any parameter in the agent:
 *   threshold = Σ p(regime_i) × config.threshold_per_regime[i]
 */
function classifyRegime(closes, interval = '15m') {
  // Not enough history — return a flat prior biased toward ranging
  if (closes.length < 10) {
    return { p_volatile: 0.10, p_trending_up: 0.20, p_trending_down: 0.20, p_ranging: 0.50 }
  }

  const last20     = closes.slice(-20)
  const logReturns = last20.slice(1).map((v, i) => Math.log(v / last20[i]))

  // ── 1. Volatility → p_volatile ─────────────────────────────────────────────
  const barsPerYear = BARS_PER_YEAR[interval] || 35040
  const realisedVol = logReturns.length >= 2
    ? stddev(logReturns) * Math.sqrt(barsPerYear)
    : 0

  // Inflection at 0.80 (v1 threshold). Steepness k=6 → p≈0.95 at vol=1.0, p≈0.05 at vol=0.60
  const p_volatile = logistic((realisedVol - 0.80) / 0.15, 6)

  // ── 2. Trend strength → blend between trending and ranging ─────────────────
  const absRets   = logReturns.map(r => Math.abs(r))
  const meanAbs   = mean(absRets)
  const sdRets    = stddev(logReturns)
  const adxProxy  = sdRets > 0 ? meanAbs / sdRets : 0

  const last10    = closes.slice(-10)
  const smaFirst  = mean(last10.slice(0, 5))
  const smaSecond = mean(last10.slice(5))
  const smaSlope  = smaFirst !== 0 ? (smaSecond - smaFirst) / smaFirst : 0

  // Two independent trend signals (v1 inflection: adxProxy=1.1, |smaSlope|=0.003)
  const adxScore   = (adxProxy - 1.1) / 0.25
  const slopeScore = (Math.abs(smaSlope) - 0.003) / 0.002
  const trendScore = Math.max(adxScore, slopeScore)

  // p_trend_raw: probability that the pair is trending (up or down) given it's not volatile
  const p_trend_raw = logistic(trendScore, 4)

  // ── 3. Direction → split trending into up / down ────────────────────────────
  // Inflection at smaSlope=0; |smaSlope|=0.003 gives p≈0.86 for the dominant direction
  const p_up = logistic(smaSlope / 0.003, 4)

  // ── 4. Combine ──────────────────────────────────────────────────────────────
  const p_not_volatile  = 1 - p_volatile
  const p_trending_up   = p_not_volatile * p_trend_raw * p_up
  const p_trending_down = p_not_volatile * p_trend_raw * (1 - p_up)
  const p_ranging       = p_not_volatile * (1 - p_trend_raw)

  // Probabilities sum to 1.0 by construction:
  // p_volatile + p_not_volatile × (p_trend_raw × p_up + p_trend_raw × (1-p_up) + (1-p_trend_raw))
  // = p_volatile + p_not_volatile × 1 = 1

  return {
    p_volatile:      round4(p_volatile),
    p_trending_up:   round4(p_trending_up),
    p_trending_down: round4(p_trending_down),
    p_ranging:       round4(p_ranging)
  }
}

function round4(v) { return Math.round(v * 10000) / 10000 }

/**
 * dominantRegime({ p_volatile, p_trending_up, p_trending_down, p_ranging })
 * Returns the regime with the highest probability, plus its probability.
 * Used for display in the TUI.
 */
function dominantRegime(probs) {
  const entries = Object.entries(probs)
  const [key, prob] = entries.reduce((best, cur) => cur[1] > best[1] ? cur : best)
  const label = key.replace('p_', '')
  return { regime: label, prob }
}

/**
 * blendThresholds(probs, thresholds)
 * Returns the probability-weighted blend of per-regime thresholds.
 *
 * thresholds: { volatile, trending_up, trending_down, ranging }
 *
 * Example:
 *   blendThresholds(probs, { volatile: 0.30, trending_up: 0.21,
 *                             trending_down: 0.25, ranging: 0.34 })
 *   → 0.27  (in a 60% trending_up / 40% ranging market)
 */
function blendThresholds(probs, thresholds) {
  return (
    probs.p_volatile      * (thresholds.volatile      ?? 0) +
    probs.p_trending_up   * (thresholds.trending_up   ?? 0) +
    probs.p_trending_down * (thresholds.trending_down ?? 0) +
    probs.p_ranging       * (thresholds.ranging       ?? 0)
  )
}

module.exports = { classifyRegime, dominantRegime, blendThresholds }
