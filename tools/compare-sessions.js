'use strict'

/**
 * tools/compare-sessions.js
 *
 * Reads all session analysis files, builds trend arrays across sessions,
 * and writes:
 *   sessions/trends.json        — consumed by detect-changes.js
 *   sessions/latest-diff.md     — human-readable diff of last two sessions
 *
 * Usage: node tools/compare-sessions.js [--latest-two]
 */

const fs   = require('fs')
const path = require('path')

const sessionDir = path.join(__dirname, '../sessions')
const trendsFile = path.join(sessionDir, 'trends.json')

// ── Load all analysis files, sorted oldest → newest ──────────────────────────
const analysisFiles = fs.readdirSync(sessionDir)
  .filter(f => f.endsWith('.analysis.json'))
  .map(f => {
    const full = path.join(sessionDir, f)
    return { f, mtime: fs.statSync(full).mtime, full }
  })
  .sort((a, b) => a.mtime - b.mtime)

if (analysisFiles.length < 1) {
  console.log('No analysis files found — nothing to compare yet.')
  process.exit(0)
}

if (analysisFiles.length < 2) {
  console.log(`Only 1 session so far — trends will build from session 2 onward.`)
  // Still write a minimal trends.json from the single session
}

const sessions = analysisFiles.map(({ full }) => JSON.parse(fs.readFileSync(full, 'utf8')))

// ── Build trends ──────────────────────────────────────────────────────────────

// agentRegimeWinRates[agent][regime]     = [winRate_s1, winRate_s2, ...]
const agentRegimeWinRates    = {}
// agentRegimeAvgPnl[agent][regime]       = [avgPnl_s1, ...]
const agentRegimeAvgPnl      = {}
// agentRegimeStopLossRate[agent][regime] = [stopLossRate_s1, ...]  (% of exits that were stop_loss)
const agentRegimeStopLossRate = {}
// agentRegimeAvgHoldRounds[agent][regime]= [avgHoldRounds_s1, ...]
const agentRegimeAvgHoldRounds = {}
// signalAccuracy[signal]                 = [accuracy_s1, ...]
const signalAccuracy      = {}
// sessionIds for reference
const sessionIds          = sessions.map(s => s.sessionId)

const agents = ['ALPHA', 'BETA', 'GAMMA', 'MEGA']

for (const session of sessions) {
  // Agent × regime trends
  for (const agentMetrics of (session.agents || [])) {
    const name = agentMetrics.agent
    if (!agents.includes(name)) continue

    if (!agentRegimeWinRates[name]) agentRegimeWinRates[name] = {}
    if (!agentRegimeAvgPnl[name])   agentRegimeAvgPnl[name]   = {}

    if (!agentRegimeStopLossRate[name])  agentRegimeStopLossRate[name]  = {}
    if (!agentRegimeAvgHoldRounds[name]) agentRegimeAvgHoldRounds[name] = {}

    for (const r of (agentMetrics.regimeStats || [])) {
      if (!agentRegimeWinRates[name][r.regime])     agentRegimeWinRates[name][r.regime]     = []
      if (!agentRegimeAvgPnl[name][r.regime])       agentRegimeAvgPnl[name][r.regime]       = []
      if (!agentRegimeStopLossRate[name][r.regime]) agentRegimeStopLossRate[name][r.regime] = []
      if (!agentRegimeAvgHoldRounds[name][r.regime]) agentRegimeAvgHoldRounds[name][r.regime] = []
      agentRegimeWinRates[name][r.regime].push(r.winRate)
      agentRegimeAvgPnl[name][r.regime].push(r.avgPnl)
      if (r.stopLossRate   != null) agentRegimeStopLossRate[name][r.regime].push(r.stopLossRate)
      if (r.avgHoldRounds  != null) agentRegimeAvgHoldRounds[name][r.regime].push(r.avgHoldRounds)
    }
  }

  // Signal accuracy trends
  for (const s of (session.signalAccuracy || [])) {
    if (s.accuracy == null) continue
    if (!signalAccuracy[s.signal]) signalAccuracy[s.signal] = []
    signalAccuracy[s.signal].push(s.accuracy)
  }
}

const trends = {
  lastUpdated:               new Date().toISOString(),
  sessionCount:              sessions.length,
  sessionIds,
  agentRegimeWinRates,
  agentRegimeAvgPnl,
  agentRegimeStopLossRate,
  agentRegimeAvgHoldRounds,
  signalAccuracy
}

fs.writeFileSync(trendsFile, JSON.stringify(trends, null, 2))
console.log(`✓ Trends updated: ${sessions.length} session(s) — ${trendsFile}`)

// ── Human-readable diff (latest two sessions only) ────────────────────────────
if (sessions.length < 2) {
  console.log('  (need 2+ sessions for diff report)')
  process.exit(0)
}

const prev = sessions[sessions.length - 2]
const curr = sessions[sessions.length - 1]

function fmt(v, unit = '%') {
  if (v == null) return 'n/a'
  const s = typeof v === 'number' ? v.toFixed(1) : v
  return `${s}${unit}`
}

function arrow(prev, curr) {
  if (prev == null || curr == null) return '~'
  return curr > prev + 1 ? '↑' : curr < prev - 1 ? '↓' : '~'
}

const lines = []
lines.push(`# Session Diff — ${prev.sessionId} → ${curr.sessionId}`)
lines.push(``)
lines.push(`Sessions: ${prev.totalRounds}r (${prev.durationHours}h) → ${curr.totalRounds}r (${curr.durationHours}h)`)
lines.push(``)

// Per-agent expectancy diff
lines.push(`## Expectancy`)
lines.push(``)
lines.push(`| Agent | Prev | Curr | Δ |`)
lines.push(`|-------|------|------|---|`)

for (const name of agents) {
  const pa = prev.agents?.find(a => a.agent === name)
  const ca = curr.agents?.find(a => a.agent === name)
  if (!pa && !ca) continue
  const pv = pa?.expectancy
  const cv = ca?.expectancy
  const delta = pv != null && cv != null ? (cv - pv).toFixed(2) : 'n/a'
  const dir   = arrow(pv, cv)
  lines.push(`| ${name} | ${fmt(pv)} | ${fmt(cv)} | ${dir} ${delta}% |`)
}
lines.push(``)

// Per-agent win rate diff by regime
lines.push(`## Win Rate by Regime`)
lines.push(``)
for (const name of agents) {
  const pa = prev.agents?.find(a => a.agent === name)
  const ca = curr.agents?.find(a => a.agent === name)
  if (!ca?.regimeStats?.length) continue

  lines.push(`### ${name}`)
  lines.push(`| Regime | Win% Prev | Win% Curr | SL% Curr | Avg Hold | Trend (win%) |`)
  lines.push(`|--------|-----------|-----------|----------|----------|--------------|`)

  for (const r of ca.regimeStats) {
    const prevStat = pa?.regimeStats?.find(x => x.regime === r.regime)
    const trend    = agentRegimeWinRates[name]?.[r.regime] || []
    const trendStr = trend.map(v => `${v.toFixed(0)}%`).join(' → ')
    const slFlag   = r.stopLossRate > 50 ? ' ⚠' : ''
    lines.push(`| ${r.regime.padEnd(13)} | ${fmt(prevStat?.winRate)} | ${fmt(r.winRate)} | ${r.stopLossRate != null ? r.stopLossRate.toFixed(0) + '%' + slFlag : 'n/a'} | ${r.avgHoldRounds != null ? r.avgHoldRounds.toFixed(1) + 'r' : 'n/a'} | ${trendStr} |`)
  }
  lines.push(``)
}

// Signal accuracy diff
lines.push(`## Signal Accuracy`)
lines.push(``)
lines.push(`| Signal | Prev | Curr | Trend |`)
lines.push(`|--------|------|------|-------|`)

const allSignals = [...new Set([
  ...(prev.signalAccuracy || []).map(s => s.signal),
  ...(curr.signalAccuracy || []).map(s => s.signal)
])]
for (const sig of allSignals) {
  const pv = prev.signalAccuracy?.find(s => s.signal === sig)?.accuracy
  const cv = curr.signalAccuracy?.find(s => s.signal === sig)?.accuracy
  const trend = (signalAccuracy[sig] || []).map(v => `${v.toFixed(0)}%`).join(' → ')
  lines.push(`| ${sig.padEnd(22)} | ${fmt(pv)} | ${fmt(cv)} | ${trend} |`)
}
lines.push(``)

lines.push(`---`)
lines.push(`*Generated by tools/compare-sessions.js*`)

const diffFile = path.join(sessionDir, 'latest-diff.md')
fs.writeFileSync(diffFile, lines.join('\n'))
console.log(`✓ Diff written:    ${diffFile}`)
