'use strict'

/**
 * tools/detect-changes.js
 *
 * Reads sessions/trends.json, applies multi-session rules, and writes
 * agents/mega-changes-proposed.json when a change is warranted.
 *
 * Rules:
 *   1. MEGA regime win rate < 42% for 3+ sessions         → raise regime buy_signal
 *   2. MEGA regime avg PnL < -0.15% for 3+ sessions       → raise regime buy_signal (expectancy)
 *   3. Peer agent consistently beats MEGA by 0.5%+ PnL    → raise regime buy_signal (peer learning)
 *   4. Signal accuracy > 65% for 5+ sessions              → upweight signal
 *   5. Signal accuracy < 50% for 5+ sessions              → downweight signal
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

const REJECT_COOLDOWN         = 3     // sessions before a rejected proposal can re-surface
const REGIME_SESSIONS_MIN     = 3     // consecutive sessions needed for regime rule
const SIGNAL_SESSIONS_MIN     = 5     // sessions needed for signal weight rule (was 10)
const REGIME_LOW_THRESHOLD    = 42    // win rate below this → tighten
const SIGNAL_HIGH_THRESHOLD   = 65    // accuracy above this → upweight
const SIGNAL_LOW_THRESHOLD    = 50    // accuracy below this → downweight
const REGIME_STEP             = 0.03  // how much to change buy_signal per proposal
const SIGNAL_STEP             = 0.10  // relative weight change (10%)
const EXPECTANCY_LOW          = -0.15 // avg PnL% below this → tighten (rule 2)
const PEER_GAP_THRESHOLD      = 0.5   // peer must beat MEGA by this avg PnL% (rule 3)
const PEERS                   = ['ALPHA', 'BETA', 'GAMMA']

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

/** Arithmetic mean */
function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length }

/** How many sessions ago was this proposal last rejected? */
function rejectedRecently(field) {
  const recent = history.rejected
    .filter(r => r.field === field)
    .sort((a, b) => b.sessionIndex - a.sessionIndex)
  if (!recent.length) return false
  return (sessionCount - recent[0].sessionIndex) < REJECT_COOLDOWN
}

/** Shared helper: build a regime buy_signal candidate */
function regimeCandidate(regime, confidence, basis, justification) {
  const field           = `regime_overrides.${regime}.buy_signal`
  if (rejectedRecently(field)) return null
  const currentOverride = megaCfg.regime_overrides?.[regime]?.buy_signal
  const current         = currentOverride ?? megaCfg.strategy.buy_signal
  if (current >= 0.50) return null
  const proposed        = parseFloat((current + REGIME_STEP).toFixed(3))
  return { confidence, field, current, proposed, basis, justification: justification(current, proposed) }
}

// ── Collect candidates ────────────────────────────────────────────────────────
const candidates = []

// ── Rule 1: MEGA regime win rate too low ──────────────────────────────────────
const megaWinRates = trends.agentRegimeWinRates?.MEGA || {}
for (const [regime, winRates] of Object.entries(megaWinRates)) {
  if (winRates.length < REGIME_SESSIONS_MIN) continue
  const recent = last(winRates, REGIME_SESSIONS_MIN)
  if (mean(recent) >= REGIME_LOW_THRESHOLD) continue
  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')
  const avg = mean(recent).toFixed(1)
  const c = regimeCandidate(regime, REGIME_SESSIONS_MIN,
    `${REGIME_SESSIONS_MIN} sessions — MEGA ${regime} avg win rate: ${avg}%`,
    (cur, prop) =>
      `MEGA's ${regime}-regime average win rate is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions (${trendStr}), below the ${REGIME_LOW_THRESHOLD}% threshold. ` +
      `Entry threshold ${cur.toFixed(3)} is admitting too many low-quality signals. Raising to ${prop.toFixed(3)} should filter for higher-conviction entries.`)
  if (c) candidates.push(c)
}

// ── Rule 2: MEGA regime expectancy persistently negative ──────────────────────
const megaAvgPnl = trends.agentRegimeAvgPnl?.MEGA || {}
for (const [regime, avgPnls] of Object.entries(megaAvgPnl)) {
  if (avgPnls.length < REGIME_SESSIONS_MIN) continue
  const recent = last(avgPnls, REGIME_SESSIONS_MIN)
  if (mean(recent) >= EXPECTANCY_LOW) continue
  const trendStr = recent.map(v => `${v.toFixed(2)}%`).join(', ')
  const avg = mean(recent).toFixed(3)
  const c = regimeCandidate(regime, REGIME_SESSIONS_MIN + 1,
    `${REGIME_SESSIONS_MIN} sessions — MEGA ${regime} avg PnL: ${avg}%`,
    (cur, prop) =>
      `MEGA's ${regime}-regime average PnL is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions ` +
      `(${trendStr}), below the ${EXPECTANCY_LOW}% threshold. Even when winning, gains are not offsetting losses. ` +
      `Raising the entry threshold to ${prop.toFixed(3)} should concentrate exposure in higher-quality setups.`)
  if (c) candidates.push(c)
}

// ── Rule 3: Peer agent consistently outperforms MEGA ─────────────────────────
for (const [regime, megaPnls] of Object.entries(megaAvgPnl)) {
  if (megaPnls.length < REGIME_SESSIONS_MIN) continue
  const megaRecent = last(megaPnls, REGIME_SESSIONS_MIN)
  const megaMean   = mean(megaRecent)

  let bestPeer = null, bestMean = -Infinity
  for (const peer of PEERS) {
    const peerPnls = trends.agentRegimeAvgPnl?.[peer]?.[regime]
    if (!peerPnls || peerPnls.length < REGIME_SESSIONS_MIN) continue
    const peerRecent = last(peerPnls, REGIME_SESSIONS_MIN)
    const m = mean(peerRecent)
    if (m > bestMean) { bestMean = m; bestPeer = peer }
  }
  if (!bestPeer) continue
  const gap = bestMean - megaMean
  if (gap < PEER_GAP_THRESHOLD) continue

  const c = regimeCandidate(regime, REGIME_SESSIONS_MIN + 2,
    `${REGIME_SESSIONS_MIN} sessions — ${bestPeer} beats MEGA by +${gap.toFixed(2)}% avg PnL in ${regime}`,
    (cur, prop) =>
      `${bestPeer} has outperformed MEGA in every ${regime} session for the last ${REGIME_SESSIONS_MIN} sessions ` +
      `(gap: +${gap.toFixed(2)}% avg PnL per trade). ${bestPeer} appears better calibrated for ${regime} conditions. ` +
      `Raising MEGA's entry threshold to ${prop.toFixed(3)} should improve selectivity and close the performance gap.`)
  if (c) candidates.push(c)
}

// ── Rules 4 & 5: Signal accuracy persistently high/low ───────────────────────
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
