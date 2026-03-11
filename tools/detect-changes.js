'use strict'

/**
 * tools/detect-changes.js
 *
 * Reads sessions/trends.json, applies multi-session rules, and writes
 * agents/mega-changes-proposed.json when a change is warranted.
 *
 * Rules:
 *   - MEGA regime win rate < 42% for 3+ consecutive sessions → raise that regime's buy_signal
 *   - MEGA regime win rate > 65% for 3+ consecutive sessions → lower that regime's buy_signal
 *   - Signal accuracy > 65% for 10+ sessions consistently   → raise that signal's weight
 *   - Signal accuracy < 50% for 10+ sessions consistently   → lower that signal's weight
 *
 * Only ONE proposal is written at a time (highest confidence first).
 * Rejected proposals are suppressed for REJECT_COOLDOWN sessions.
 *
 * Usage: node tools/detect-changes.js
 */

const fs   = require('fs')
const path = require('path')

const sessionDir   = path.join(__dirname, '../sessions')
const trendsFile   = path.join(sessionDir, 'trends.json')
const configFile   = path.join(__dirname, '../agents/mega-config.json')
const proposedFile = path.join(__dirname, '../agents/mega-changes-proposed.json')
const historyFile  = path.join(sessionDir, 'change-history.json')

const REJECT_COOLDOWN       = 3   // sessions before a rejected proposal can re-surface
const REGIME_SESSIONS_MIN   = 3   // consecutive sessions needed for regime rule
const SIGNAL_SESSIONS_MIN   = 10  // sessions needed for signal weight rule
const REGIME_LOW_THRESHOLD  = 42  // win rate below this → tighten
const REGIME_HIGH_THRESHOLD = 65  // win rate above this → loosen (not implemented yet, future)
const SIGNAL_HIGH_THRESHOLD = 65  // accuracy above this → upweight
const SIGNAL_LOW_THRESHOLD  = 50  // accuracy below this → downweight
const REGIME_STEP           = 0.03  // how much to change buy_signal per proposal
const SIGNAL_STEP           = 0.10  // relative weight change (10%)

// ── Load files ────────────────────────────────────────────────────────────────
if (!fs.existsSync(trendsFile)) {
  console.log('No trends.json found — run compare-sessions.js first.')
  process.exit(0)
}

const trends   = JSON.parse(fs.readFileSync(trendsFile, 'utf8'))
const megaCfg  = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const history  = fs.existsSync(historyFile)
  ? JSON.parse(fs.readFileSync(historyFile, 'utf8'))
  : { applied: [], rejected: [] }

const sessionCount = trends.sessionCount

if (sessionCount < REGIME_SESSIONS_MIN) {
  console.log(`Only ${sessionCount} session(s) — need ${REGIME_SESSIONS_MIN} before change detection runs.`)
  process.exit(0)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Last N values of an array */
function last(arr, n) { return arr.slice(-n) }

/** Check if all values in array satisfy predicate */
function allMatch(arr, fn) { return arr.length > 0 && arr.every(fn) }

/** How many sessions ago was this proposal last rejected? */
function rejectedRecently(field) {
  const recent = history.rejected
    .filter(r => r.field === field)
    .sort((a, b) => b.sessionIndex - a.sessionIndex)
  if (!recent.length) return false
  return (sessionCount - recent[0].sessionIndex) < REJECT_COOLDOWN
}

// ── Collect candidates ────────────────────────────────────────────────────────
const candidates = []

// ── Rule 1: MEGA regime win rate too low ──────────────────────────────────────
const megaRegimes = trends.agentRegimeWinRates?.MEGA || {}
for (const [regime, winRates] of Object.entries(megaRegimes)) {
  if (winRates.length < REGIME_SESSIONS_MIN) continue

  const recent = last(winRates, REGIME_SESSIONS_MIN)
  if (!allMatch(recent, v => v < REGIME_LOW_THRESHOLD)) continue

  const field     = `regime_overrides.${regime}.buy_signal`
  if (rejectedRecently(field)) continue

  const currentOverride = megaCfg.regime_overrides?.[regime]?.buy_signal
  const currentBase     = megaCfg.strategy.buy_signal
  const current         = currentOverride ?? currentBase
  const proposed        = parseFloat((current + REGIME_STEP).toFixed(3))

  // Don't keep raising past 0.50
  if (current >= 0.50) continue

  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')

  candidates.push({
    confidence: REGIME_SESSIONS_MIN,
    field,
    current,
    proposed,
    basis: `${REGIME_SESSIONS_MIN} consecutive sessions — MEGA ${regime}-regime win rate: ${trendStr}`,
    justification:
      `MEGA's ${regime}-regime entries have underperformed for ${REGIME_SESSIONS_MIN} consecutive sessions ` +
      `(win rate: ${trendStr}, all below ${REGIME_LOW_THRESHOLD}%). ` +
      `The current entry threshold of ${current.toFixed(3)} is admitting too many low-quality signals ` +
      `in ${regime} conditions. A conservative raise to ${proposed.toFixed(3)} reduces exposure ` +
      `without eliminating the regime entirely. Revert if the next session shows win rate drops further ` +
      `(may indicate the market is structural, not threshold-related).`
  })
}

// ── Rule 2: Signal accuracy persistently below threshold ─────────────────────
if (sessionCount >= SIGNAL_SESSIONS_MIN) {
  const weights = { ...megaCfg.signal_weights }

  for (const [signal, accuracies] of Object.entries(trends.signalAccuracy || {})) {
    if (accuracies.length < SIGNAL_SESSIONS_MIN) continue

    const recent = last(accuracies, SIGNAL_SESSIONS_MIN)

    // Map signal accuracy key to weight key
    const weightKey = signal === 'composite_signal' ? null
      : signal === 'cvd_norm'       ? 'cvd_norm'
      : signal === 'funding_signal' ? 'funding_signal'
      : null
    if (!weightKey || weights[weightKey] == null) continue

    if (allMatch(recent, v => v < SIGNAL_LOW_THRESHOLD)) {
      const field   = `signal_weights.${weightKey}`
      if (rejectedRecently(field)) continue

      const current  = weights[weightKey]
      const proposed = parseFloat((current * (1 - SIGNAL_STEP)).toFixed(3))
      const avg      = (recent.reduce((s, v) => s + v, 0) / recent.length).toFixed(1)

      candidates.push({
        confidence: SIGNAL_SESSIONS_MIN,
        field,
        current,
        proposed,
        basis:         `${SIGNAL_SESSIONS_MIN} sessions — ${signal} avg accuracy: ${avg}% (below ${SIGNAL_LOW_THRESHOLD}%)`,
        justification: `${signal} has been below ${SIGNAL_LOW_THRESHOLD}% accuracy for ${SIGNAL_SESSIONS_MIN} consecutive sessions ` +
          `(average: ${avg}%). This signal is adding noise rather than predictive value. ` +
          `Reducing its weight from ${current} to ${proposed} (−10%) and redistributing will improve signal quality. ` +
          `Note: signal_weights will be renormalized after applying.`
      })
    }

    if (allMatch(recent, v => v > SIGNAL_HIGH_THRESHOLD)) {
      const field   = `signal_weights.${weightKey}`
      if (rejectedRecently(field)) continue

      const current  = weights[weightKey]
      const proposed = parseFloat((current * (1 + SIGNAL_STEP)).toFixed(3))
      const avg      = (recent.reduce((s, v) => s + v, 0) / recent.length).toFixed(1)

      candidates.push({
        confidence: SIGNAL_SESSIONS_MIN,
        field,
        current,
        proposed,
        basis:         `${SIGNAL_SESSIONS_MIN} sessions — ${signal} avg accuracy: ${avg}% (above ${SIGNAL_HIGH_THRESHOLD}%)`,
        justification: `${signal} has been above ${SIGNAL_HIGH_THRESHOLD}% accuracy for ${SIGNAL_SESSIONS_MIN} consecutive sessions ` +
          `(average: ${avg}%). This signal has proven predictive power. ` +
          `Raising its weight from ${current} to ${proposed} (+10%) amplifies a reliable edge. ` +
          `Note: signal_weights will be renormalized after applying.`
      })
    }
  }
}

// ── Pick highest-confidence proposal ─────────────────────────────────────────
if (!candidates.length) {
  console.log(`No change proposals — patterns not yet consistent enough. (${sessionCount} sessions)`)
  // Clear any stale proposed file
  if (fs.existsSync(proposedFile)) fs.unlinkSync(proposedFile)
  process.exit(0)
}

// Sort by confidence descending, then by most recent field first
candidates.sort((a, b) => b.confidence - a.confidence)
const top = candidates[0]
const deferred = candidates.slice(1).map(c => ({ field: c.field, basis: c.basis }))

const proposal = {
  generatedAt:      new Date().toISOString(),
  sessionsAnalyzed: sessionCount,
  proposals: [
    {
      field:         top.field,
      current:       top.current,
      proposed:      top.proposed,
      confidence:    top.basis,
      justification: top.justification,
      deferred
    }
  ]
}

fs.writeFileSync(proposedFile, JSON.stringify(proposal, null, 2))
console.log(`✓ Proposal written: ${top.field} ${top.current} → ${top.proposed}`)
console.log(`  Basis: ${top.basis}`)
if (deferred.length) {
  console.log(`  Deferred: ${deferred.map(d => d.field).join(', ')}`)
}
