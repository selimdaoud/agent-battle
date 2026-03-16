'use strict'

/**
 * tools/detect-changes.js
 *
 * Reads sessions/trends.json, applies multi-session rules, and writes
 * agents/mega-changes-proposed.json when a change is warranted.
 *
 * Rules use the session-aligned mean of A/B/G agents (not MEGA) as the regime signal.
 * MEGA has sparse data; A/B/G run every session and provide a reliable market proxy.
 *
 * Rules:
 *   1. A/B/G combined regime win rate < 42% for 3+ sessions  → raise MEGA regime buy_signal
 *   2. A/B/G combined regime avg PnL < -0.15% for 3+ sessions → raise MEGA regime buy_signal
 *   3. (removed — was peer vs MEGA comparison, no longer applicable)
 *   4. Signal accuracy > 65% for 5+ sessions                 → upweight signal
 *   5. Signal accuracy < 50% for 5+ sessions                 → downweight signal
 *   6. A/B/G combined regime win rate > 70% for 3+ sessions   → lower MEGA regime buy_signal
 *   7. A/B/G combined regime avg PnL > 0.50% for 3+ sessions  → lower MEGA regime buy_signal
 *   8. A/B/G combined stop_loss exit rate > 50% for 3+ sessions → raise MEGA regime sell_loss_pct (+1pp)
 *  8b. A/B/G combined stop_loss exit rate < 15% for 3+ sessions → lower MEGA regime sell_loss_pct (−1pp, floor 4%)
 *   9. MEGA deadweight exit rate > 40% for 3+ sessions           → raise strategy.deadweight_rounds_min (+2, max 15)
 *  9b. MEGA deadweight exit rate < 15% for 3+ sessions           → lower strategy.deadweight_rounds_min (−2, floor 5)
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

const REJECT_COOLDOWN          = 3     // sessions before a rejected proposal can re-surface
const REGIME_SESSIONS_MIN      = 3     // consecutive sessions needed for regime rule
const SIGNAL_SESSIONS_MIN      = 5     // sessions needed for signal weight rule (was 10)
const REGIME_LOW_THRESHOLD     = 42    // win rate below this → tighten (rule 1)
const REGIME_HIGH_THRESHOLD    = 70    // win rate above this → loosen (rule 6 — too selective)
const SIGNAL_HIGH_THRESHOLD    = 65    // accuracy above this → upweight
const SIGNAL_LOW_THRESHOLD     = 50    // accuracy below this → downweight
const REGIME_STEP              = 0.03  // how much to change buy_signal per proposal
const SIGNAL_STEP              = 0.10  // relative weight change (10%)
const EXPECTANCY_LOW           = -0.15 // avg PnL% below this → tighten (rule 2)
const EXPECTANCY_HIGH          = 0.50  // avg PnL% above this → loosen (rule 7 — missing volume)
const BUY_SIGNAL_FLOOR         = 0.05  // never propose lowering buy_signal below this
const STOP_LOSS_HIGH_THRESHOLD    = 50    // stop_loss exit rate above this → stop too tight (rule 8)
const STOP_LOSS_LOW_THRESHOLD     = 15    // stop_loss exit rate below this → stop may be too wide (rule 8b)
const SELL_LOSS_STEP              = 1     // percentage points to change stop-loss per proposal
const SELL_LOSS_CEILING           = 12    // never propose sell_loss_pct above this
const SELL_LOSS_FLOOR             = 4     // never propose sell_loss_pct below this
const DEADWEIGHT_HIGH_THRESHOLD   = 40    // MEGA deadweight exit rate above this → rounds too short (rule 9)
const DEADWEIGHT_LOW_THRESHOLD    = 15    // MEGA deadweight exit rate below this → rounds too long (rule 9b)
const DEADWEIGHT_STEP             = 2     // rounds to change per proposal
const DEADWEIGHT_CEILING          = 15    // never propose deadweight_rounds_min above this
const DEADWEIGHT_FLOOR            = 5     // never propose deadweight_rounds_min below this
const PEERS                       = ['ALPHA', 'BETA', 'GAMMA']

// ── Build session-aligned combined A/B/G trend arrays ────────────────────────
// Each agent's array may be shorter than total session count — assumed to
// represent the most recent sessions (earlier sessions had no trades in that regime).
// For each position, average across agents that have data at that position.
function buildCombined(dataByAgent) {
  const combined = {}
  const regimes = new Set()
  for (const agent of PEERS) {
    for (const regime of Object.keys(dataByAgent?.[agent] || {})) regimes.add(regime)
  }
  for (const regime of regimes) {
    const arrays = PEERS
      .map(a => dataByAgent?.[a]?.[regime] || [])
      .filter(arr => arr.length > 0)
    if (!arrays.length) continue
    const maxLen = Math.max(...arrays.map(a => a.length))
    const result = []
    for (let i = 0; i < maxLen; i++) {
      // Align each array to the right: position i corresponds to array index (arr.length - maxLen + i)
      const vals = []
      for (const arr of arrays) {
        const idx = arr.length - maxLen + i
        if (idx >= 0) vals.push(arr[idx])
      }
      if (vals.length > 0) result.push(parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)))
    }
    combined[regime] = result
  }
  return combined
}

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

/** Shared helper: build a regime buy_signal tightening candidate */
function regimeCandidate(regime, confidence, basis, justification) {
  const field           = `regime_overrides.${regime}.buy_signal`
  if (rejectedRecently(field)) return null
  const currentOverride = megaCfg.regime_overrides?.[regime]?.buy_signal
  const current         = currentOverride ?? megaCfg.strategy.buy_signal
  if (current >= 0.50) return null
  const proposed        = parseFloat((current + REGIME_STEP).toFixed(3))
  return { confidence, field, current, proposed, basis, justification: justification(current, proposed) }
}

/** Shared helper: build a regime buy_signal loosening candidate */
function looseRegimeCandidate(regime, confidence, basis, justification) {
  const field           = `regime_overrides.${regime}.buy_signal`
  if (rejectedRecently(field)) return null
  const currentOverride = megaCfg.regime_overrides?.[regime]?.buy_signal
  const current         = currentOverride ?? megaCfg.strategy.buy_signal
  if (current <= BUY_SIGNAL_FLOOR) return null  // floor — never go below 0.05
  const proposed        = parseFloat((current - REGIME_STEP).toFixed(3))
  return { confidence, field, current, proposed, basis, justification: justification(current, proposed) }
}

/** Build a regime sell_loss_pct widening candidate (stop too tight) */
function stopLossCandidate(regime, confidence, basis, justification) {
  const field   = `regime_overrides.${regime}.sell_loss_pct`
  if (rejectedRecently(field)) return null
  const current = megaCfg.regime_overrides?.[regime]?.sell_loss_pct ?? megaCfg.strategy.sell_loss_pct
  if (current >= SELL_LOSS_CEILING) return null
  const proposed = current + SELL_LOSS_STEP
  return { confidence, field, current, proposed, basis, justification: justification(current, proposed) }
}

/** Build a regime sell_loss_pct tightening candidate (stop too wide) */
function stopLossTightenCandidate(regime, confidence, basis, justification) {
  const field   = `regime_overrides.${regime}.sell_loss_pct`
  if (rejectedRecently(field)) return null
  const current = megaCfg.regime_overrides?.[regime]?.sell_loss_pct ?? megaCfg.strategy.sell_loss_pct
  if (current <= SELL_LOSS_FLOOR) return null
  const proposed = current - SELL_LOSS_STEP
  return { confidence, field, current, proposed, basis, justification: justification(current, proposed) }
}

// ── Build combined A/B/G baselines ───────────────────────────────────────────
const combinedWinRates     = buildCombined(trends.agentRegimeWinRates)
const combinedAvgPnl       = buildCombined(trends.agentRegimeAvgPnl)
const combinedStopLossRate = buildCombined(trends.agentRegimeStopLossRate || {})

// ── Collect candidates ────────────────────────────────────────────────────────
const candidates = []

// ── Rule 1: A/B/G combined regime win rate too low ───────────────────────────
for (const [regime, winRates] of Object.entries(combinedWinRates)) {
  if (winRates.length < REGIME_SESSIONS_MIN) continue
  const recent = last(winRates, REGIME_SESSIONS_MIN)
  if (mean(recent) >= REGIME_LOW_THRESHOLD) continue
  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')
  const avg = mean(recent).toFixed(1)
  const c = regimeCandidate(regime, REGIME_SESSIONS_MIN,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} avg win rate: ${avg}%`,
    (cur, prop) =>
      `A/B/G combined ${regime}-regime average win rate is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions (${trendStr}), below the ${REGIME_LOW_THRESHOLD}% threshold. ` +
      `Market conditions in ${regime} are unfavourable. Raising MEGA's entry threshold to ${prop.toFixed(3)} should filter for higher-conviction signals.`)
  if (c) candidates.push(c)
}

// ── Rule 2: A/B/G combined regime expectancy persistently negative ────────────
for (const [regime, avgPnls] of Object.entries(combinedAvgPnl)) {
  if (avgPnls.length < REGIME_SESSIONS_MIN) continue
  const recent = last(avgPnls, REGIME_SESSIONS_MIN)
  if (mean(recent) >= EXPECTANCY_LOW) continue
  const trendStr = recent.map(v => `${v.toFixed(2)}%`).join(', ')
  const avg = mean(recent).toFixed(3)
  const c = regimeCandidate(regime, REGIME_SESSIONS_MIN + 1,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} avg PnL: ${avg}%`,
    (cur, prop) =>
      `A/B/G combined ${regime}-regime average PnL is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions ` +
      `(${trendStr}), below the ${EXPECTANCY_LOW}% threshold. Regime conditions are persistently unfavourable. ` +
      `Raising MEGA's entry threshold to ${prop.toFixed(3)} should concentrate exposure in higher-quality setups.`)
  if (c) candidates.push(c)
}

// ── Rule 6: A/B/G combined regime win rate too high — MEGA too selective ──────
for (const [regime, winRates] of Object.entries(combinedWinRates)) {
  if (winRates.length < REGIME_SESSIONS_MIN) continue
  const recent = last(winRates, REGIME_SESSIONS_MIN)
  if (mean(recent) <= REGIME_HIGH_THRESHOLD) continue
  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')
  const avg = mean(recent).toFixed(1)
  const c = looseRegimeCandidate(regime, REGIME_SESSIONS_MIN,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} avg win rate: ${avg}% (too selective)`,
    (cur, prop) =>
      `A/B/G combined ${regime}-regime win rate is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions (${trendStr}), ` +
      `above the ${REGIME_HIGH_THRESHOLD}% threshold. Conditions in ${regime} are strongly favourable. ` +
      `Lowering MEGA's entry threshold from ${cur.toFixed(3)} to ${prop.toFixed(3)} should capture more volume without sacrificing edge.`)
  if (c) candidates.push(c)
}

// ── Rule 7: A/B/G combined regime expectancy strong — room to capture more ────
for (const [regime, avgPnls] of Object.entries(combinedAvgPnl)) {
  if (avgPnls.length < REGIME_SESSIONS_MIN) continue
  const recent = last(avgPnls, REGIME_SESSIONS_MIN)
  if (mean(recent) < EXPECTANCY_HIGH) continue
  const trendStr = recent.map(v => `${v.toFixed(2)}%`).join(', ')
  const avg = mean(recent).toFixed(3)
  const c = looseRegimeCandidate(regime, REGIME_SESSIONS_MIN,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} avg PnL: ${avg}% (strong expectancy)`,
    (cur, prop) =>
      `A/B/G combined ${regime}-regime average PnL is ${avg}% over the last ${REGIME_SESSIONS_MIN} sessions ` +
      `(${trendStr}), consistently above ${EXPECTANCY_HIGH}%. Conditions in ${regime} have proven edge; ` +
      `MEGA's current entry threshold ${cur.toFixed(3)} may be leaving profitable setups on the table. ` +
      `Lowering to ${prop.toFixed(3)} to capture more volume while conditions are confirmed.`)
  if (c) candidates.push(c)
}

// ── Rule 8: Stop-loss hit rate persistently high — stop too tight ─────────────
for (const [regime, rates] of Object.entries(combinedStopLossRate)) {
  if (rates.length < REGIME_SESSIONS_MIN) continue
  const recent = last(rates, REGIME_SESSIONS_MIN)
  if (mean(recent) <= STOP_LOSS_HIGH_THRESHOLD) continue
  const avg      = mean(recent).toFixed(1)
  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')
  const c = stopLossCandidate(regime, REGIME_SESSIONS_MIN + 1,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} stop_loss exit rate: ${avg}%`,
    (cur, prop) =>
      `A/B/G agents were stopped out on ${avg}% of ${regime}-regime trades over the last ${REGIME_SESSIONS_MIN} sessions (${trendStr}), ` +
      `above the ${STOP_LOSS_HIGH_THRESHOLD}% threshold. The current ${regime} stop at ${cur}% is too tight — ` +
      `positions are being closed before they have room to recover. ` +
      `Widening to ${prop}% reduces noise-stop frequency without materially increasing max loss per trade.`)
  if (c) candidates.push(c)
}

// ── Rule 8b: Stop-loss hit rate persistently low — stop may be too wide ───────
for (const [regime, rates] of Object.entries(combinedStopLossRate)) {
  if (rates.length < REGIME_SESSIONS_MIN) continue
  const recent = last(rates, REGIME_SESSIONS_MIN)
  if (mean(recent) >= STOP_LOSS_LOW_THRESHOLD) continue
  const avg      = mean(recent).toFixed(1)
  const trendStr = recent.map(v => `${v.toFixed(0)}%`).join(', ')
  const c = stopLossTightenCandidate(regime, REGIME_SESSIONS_MIN,
    `${REGIME_SESSIONS_MIN} sessions — A/B/G combined ${regime} stop_loss exit rate: ${avg}% (low)`,
    (cur, prop) =>
      `A/B/G agents were stopped out on only ${avg}% of ${regime}-regime trades over the last ${REGIME_SESSIONS_MIN} sessions (${trendStr}), ` +
      `below the ${STOP_LOSS_LOW_THRESHOLD}% threshold. The current ${regime} stop at ${cur}% may be giving back ` +
      `more P&L on losing trades than necessary. Tightening to ${prop}% recovers some of that without meaningfully ` +
      `increasing the stop-out frequency given current conditions.`)
  if (c) candidates.push(c)
}

// ── Rule 9: MEGA deadweight exit rate persistently high — rounds too short ────
const megaDwRates = trends.megaDeadweightRate || []
if (megaDwRates.length >= REGIME_SESSIONS_MIN) {
  const recent = last(megaDwRates, REGIME_SESSIONS_MIN)
  if (mean(recent) > DEADWEIGHT_HIGH_THRESHOLD) {
    const field   = 'strategy.deadweight_rounds_min'
    const current = megaCfg.strategy.deadweight_rounds_min ?? 5
    if (!rejectedRecently(field) && current < DEADWEIGHT_CEILING) {
      const proposed  = current + DEADWEIGHT_STEP
      const avg       = mean(recent).toFixed(1)
      const trendStr  = recent.map(v => `${v.toFixed(0)}%`).join(', ')
      candidates.push({
        confidence:    REGIME_SESSIONS_MIN + 1,
        field,
        current,
        proposed,
        basis:         `${REGIME_SESSIONS_MIN} sessions — MEGA deadweight exit rate: ${avg}%`,
        justification: `MEGA exited ${avg}% of positions as deadweight over the last ${REGIME_SESSIONS_MIN} sessions ` +
          `(${trendStr}), above the ${DEADWEIGHT_HIGH_THRESHOLD}% threshold. Positions are being flagged as ` +
          `stale before they have time to develop — the current ${current}-round minimum is too short for MEGA's ` +
          `capital size and the pairs it trades. Raising to ${proposed} rounds gives positions more time to move ` +
          `before triggering a deadweight exit.`
      })
    }
  }
}

// ── Rule 9b: MEGA deadweight exit rate persistently low — rounds too long ─────
if (megaDwRates.length >= REGIME_SESSIONS_MIN) {
  const recent = last(megaDwRates, REGIME_SESSIONS_MIN)
  if (mean(recent) < DEADWEIGHT_LOW_THRESHOLD) {
    const field   = 'strategy.deadweight_rounds_min'
    const current = megaCfg.strategy.deadweight_rounds_min ?? 5
    if (!rejectedRecently(field) && current > DEADWEIGHT_FLOOR) {
      const proposed  = current - DEADWEIGHT_STEP
      const avg       = mean(recent).toFixed(1)
      const trendStr  = recent.map(v => `${v.toFixed(0)}%`).join(', ')
      candidates.push({
        confidence:    REGIME_SESSIONS_MIN + 1,
        field,
        current,
        proposed,
        basis:         `${REGIME_SESSIONS_MIN} sessions — MEGA deadweight exit rate: ${avg}% (low)`,
        justification: `MEGA exited only ${avg}% of positions as deadweight over the last ${REGIME_SESSIONS_MIN} sessions ` +
          `(${trendStr}), below the ${DEADWEIGHT_LOW_THRESHOLD}% threshold. Positions are consistently moving before ` +
          `the deadweight timer fires — the current ${current}-round minimum may be higher than necessary. ` +
          `Lowering to ${proposed} rounds frees capital sooner in genuinely stalled situations ` +
          `without cutting positions that are still developing.`
      })
    }
  }
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
