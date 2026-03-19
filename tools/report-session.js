'use strict'

/**
 * tools/report-session.js
 *
 * Reads a session JSON file and writes a human-readable session-report.md
 * alongside it in the sessions/ directory.
 *
 * Also writes session-analysis.json — structured metrics for compare-sessions.js
 *
 * Usage: node tools/report-session.js [--session <path>] [--latest]
 */

const fs   = require('fs')
const path = require('path')

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2)
const sessionDir = path.join(__dirname, '../sessions')

let sessionFile
if (args.includes('--session')) {
  sessionFile = args[args.indexOf('--session') + 1]
} else {
  // Default: latest session JSON (not meta)
  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json') && !f.endsWith('.analysis.json'))
    .map(f => ({ f, mtime: fs.statSync(path.join(sessionDir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!files.length) { console.error('No session files found in sessions/'); process.exit(1) }
  sessionFile = path.join(sessionDir, files[0].f)
}

if (!fs.existsSync(sessionFile)) {
  console.error(`Session file not found: ${sessionFile}`)
  process.exit(1)
}

const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
const { meta, closedTrades, closedShorts = [], survivalEvents, agentSummary } = session
const agents = ['ALPHA', 'BETA', 'GAMMA', 'MEGA']

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(n) { return n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : 'n/a' }
function num(n, d = 2) { return n != null ? n.toFixed(d) : 'n/a' }
function bar(val, max, width = 20) {
  const filled = max > 0 ? Math.round((val / max) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ── Per-agent trade metrics ───────────────────────────────────────────────────
function agentMetrics(agentName) {
  const trades = closedTrades.filter(t => t.agent === agentName && t.realizedPnlPct != null)
  if (!trades.length) return null

  const wins    = trades.filter(t => t.realizedPnlPct > 0)
  const losses  = trades.filter(t => t.realizedPnlPct <= 0)
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.realizedPnlPct, 0) / wins.length   : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realizedPnlPct, 0) / losses.length : 0
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss
  const avgHold = trades.reduce((s, t) => s + t.roundsHeld, 0) / trades.length

  // Time in market: rounds with an open position (approximation from trade rounds)
  const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0)

  // By regime
  const byRegime = {}
  for (const t of trades) {
    const r = t.regimeAtEntry || 'unknown'
    if (!byRegime[r]) byRegime[r] = { trades: [], wins: 0 }
    byRegime[r].trades.push(t)
    if (t.realizedPnlPct > 0) byRegime[r].wins++
  }
  const regimeStats = Object.entries(byRegime).map(([regime, d]) => {
    const n                = d.trades.length
    const stopLossCount    = d.trades.filter(t => t.exitReason === 'stop_loss').length
    const deadweightCount  = d.trades.filter(t => t.exitReason === 'deadweight').length
    return {
      regime,
      count:           n,
      winRate:         parseFloat(((d.wins / n) * 100).toFixed(1)),
      avgPnl:          parseFloat((d.trades.reduce((s, t) => s + t.realizedPnlPct, 0) / n).toFixed(3)),
      stopLossRate:    parseFloat(((stopLossCount / n) * 100).toFixed(1)),
      deadweightRate:  parseFloat(((deadweightCount / n) * 100).toFixed(1)),
      avgHoldRounds:   parseFloat((d.trades.reduce((s, t) => s + t.roundsHeld, 0) / n).toFixed(1))
    }
  })

  // Exit reason breakdown
  const byExit = {}
  for (const t of trades) {
    byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1
  }

  return {
    agent: agentName,
    tradeCount: trades.length,
    winRate:    parseFloat(winRate.toFixed(1)),
    avgWin:     parseFloat(avgWin.toFixed(3)),
    avgLoss:    parseFloat(avgLoss.toFixed(3)),
    expectancy: parseFloat(expectancy.toFixed(3)),
    avgHold:    parseFloat(avgHold.toFixed(1)),
    totalFees:  parseFloat(totalFees.toFixed(4)),
    regimeStats,
    byExit,
    eliminations: agentSummary[agentName]?.eliminations || 0,
    respawns:     agentSummary[agentName]?.respawns     || 0,
  }
}

// ── GAMMA short metrics ───────────────────────────────────────────────────────
function gammaShortMetrics() {
  const shorts = closedShorts.filter(t => t.realizedPnlPct != null)
  if (!shorts.length) return null

  const wins    = shorts.filter(t => t.realizedPnlPct > 0)
  const losses  = shorts.filter(t => t.realizedPnlPct <= 0)
  const winRate = (wins.length / shorts.length) * 100
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.realizedPnlPct, 0) / wins.length   : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realizedPnlPct, 0) / losses.length : 0
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss
  const avgHold    = shorts.reduce((s, t) => s + t.roundsHeld, 0) / shorts.length

  const byRegime = {}
  for (const t of shorts) {
    const r = t.regimeAtEntry || 'unknown'
    if (!byRegime[r]) byRegime[r] = { trades: [], wins: 0 }
    byRegime[r].trades.push(t)
    if (t.realizedPnlPct > 0) byRegime[r].wins++
  }
  const regimeStats = Object.entries(byRegime).map(([regime, d]) => {
    const n             = d.trades.length
    const stopLossCount = d.trades.filter(t => t.exitReason === 'stop_loss').length
    return {
      regime,
      count:         n,
      winRate:       parseFloat(((d.wins / n) * 100).toFixed(1)),
      avgPnl:        parseFloat((d.trades.reduce((s, t) => s + t.realizedPnlPct, 0) / n).toFixed(3)),
      stopLossRate:  parseFloat(((stopLossCount / n) * 100).toFixed(1)),
      avgHoldRounds: parseFloat((d.trades.reduce((s, t) => s + t.roundsHeld, 0) / n).toFixed(1))
    }
  })

  const byExit = {}
  for (const t of shorts) { byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1 }

  return {
    tradeCount:  shorts.length,
    winRate:     parseFloat(winRate.toFixed(1)),
    avgWin:      parseFloat(avgWin.toFixed(3)),
    avgLoss:     parseFloat(avgLoss.toFixed(3)),
    expectancy:  parseFloat(expectancy.toFixed(3)),
    avgHold:     parseFloat(avgHold.toFixed(1)),
    regimeStats,
    byExit
  }
}

// ── Signal accuracy ───────────────────────────────────────────────────────────
function signalAccuracy() {
  const signals = [
    'signalAtEntry',   // composite
    'cvdAtEntry',
    'fundingAtEntry',
    'fearGreedAtEntry'
  ]

  // For the composite signal: high score → profitable?
  const signalStats = {}

  for (const t of closedTrades) {
    if (t.realizedPnlPct == null) continue
    const won = t.realizedPnlPct > 0

    // Composite signal direction
    if (t.signalAtEntry != null) {
      const s = 'composite_signal'
      if (!signalStats[s]) signalStats[s] = { correct: 0, total: 0 }
      const predicted = t.signalAtEntry > 0
      if (predicted === won) signalStats[s].correct++
      signalStats[s].total++
    }

    // CVD: positive at entry → profitable?
    if (t.cvdAtEntry != null) {
      const s = 'cvd_norm'
      if (!signalStats[s]) signalStats[s] = { correct: 0, total: 0 }
      const predicted = t.cvdAtEntry > 0
      if (predicted === won) signalStats[s].correct++
      signalStats[s].total++
    }

    // Funding: low funding at entry → profitable? (low = not crowded = better)
    if (t.fundingAtEntry != null) {
      const s = 'funding_signal'
      if (!signalStats[s]) signalStats[s] = { correct: 0, total: 0 }
      const predicted = t.fundingAtEntry < 0.5  // below 0.5 = not too crowded
      if (predicted === won) signalStats[s].correct++
      signalStats[s].total++
    }
  }

  return Object.entries(signalStats).map(([signal, d]) => ({
    signal,
    accuracy: d.total > 0 ? parseFloat(((d.correct / d.total) * 100).toFixed(1)) : null,
    sample:   d.total
  })).sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0))
}

// ── Top / worst trades ────────────────────────────────────────────────────────
function topTrades(n = 5) {
  return [...closedTrades]
    .filter(t => t.realizedPnlPct != null)
    .sort((a, b) => b.realizedPnlPct - a.realizedPnlPct)
    .slice(0, n)
}

function worstTrades(n = 5) {
  return [...closedTrades]
    .filter(t => t.realizedPnlPct != null)
    .sort((a, b) => a.realizedPnlPct - b.realizedPnlPct)
    .slice(0, n)
}

// ── Build analysis object ─────────────────────────────────────────────────────
const metrics = agents.map(agentMetrics).filter(Boolean)
const sigAccuracy = signalAccuracy()
const shortMetrics = gammaShortMetrics()

const analysis = {
  sessionId:       meta.sessionId,
  totalRounds:     meta.totalRounds,
  durationHours:   meta.durationHours,
  agents:          metrics,
  signalAccuracy:  sigAccuracy,
  topTrades:       topTrades(5),
  worstTrades:     worstTrades(5),
  survivalEvents:  survivalEvents.length,
  gammaShorts:     shortMetrics
}

// ── Write analysis JSON ───────────────────────────────────────────────────────
const analysisFile = sessionFile.replace('.json', '.analysis.json')
fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2))

// ── Generate Markdown report ──────────────────────────────────────────────────
function tradeRow(t) {
  const pair  = t.pair.replace('USDT', '/USDT')
  const label = `${t.agent} ${pair}`
  return `| ${label.padEnd(18)} | ${String(t.entryRound).padStart(4)} → ${String(t.exitRound).padStart(4)} | ${String(t.roundsHeld).padStart(3)}r | ${pct(t.realizedPnlPct).padStart(8)} | ${(t.regimeAtEntry || 'n/a').padEnd(13)} | ${(t.exitReason || 'n/a').padEnd(16)} | cvd=${num(t.cvdAtEntry, 2)} |`
}

const winner = metrics.sort((a, b) => b.expectancy - a.expectancy)[0]
const regimeCounts = {}
for (const t of closedTrades) {
  const r = t.regimeAtEntry || 'unknown'
  regimeCounts[r] = (regimeCounts[r] || 0) + 1
}
const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'

const lines = []

lines.push(`# Session Report — ${meta.sessionId}`)
lines.push(``)
lines.push(`Exported: ${meta.exportedAt}  |  Rounds: ${meta.totalRounds}  |  Duration: ${meta.durationHours}h  |  Dominant regime: **${dominantRegime}**`)
lines.push(``)

// ── Executive Summary ─────────────────────────────────────────────────────────
lines.push(`## Executive Summary`)
lines.push(``)
lines.push(`| Agent | Trades | Win Rate | Expectancy | Avg Hold | Fees | Elim | Respawns |`)
lines.push(`|-------|--------|----------|------------|----------|------|------|----------|`)
for (const name of agents) {
  const m   = metrics.find(x => x.agent === name)
  const sum = agentSummary[name]
  if (m) {
    lines.push(`| **${m.agent}** | ${m.tradeCount} | ${m.winRate.toFixed(1)}% | ${pct(m.expectancy)} | ${m.avgHold.toFixed(1)}r | $${m.totalFees.toFixed(3)} | ${m.eliminations} | ${m.respawns} |`)
  } else if (sum) {
    const openBuys = sum.totalTrades || 0
    const note = openBuys > 0 ? `${openBuys} open` : '—'
    lines.push(`| ${name} | ${note} | — | — | — | $${(sum.totalFees || 0).toFixed(3)} | ${sum.eliminations || 0} | ${sum.respawns || 0} |`)
  }
}
lines.push(``)
if (winner) lines.push(`Best expectancy: **${winner.agent}** (${pct(winner.expectancy)} per trade)`)
lines.push(``)

// ── Per-Agent Regime Breakdown ────────────────────────────────────────────────
lines.push(`## Performance by Regime`)
lines.push(``)
for (const m of metrics) {
  if (!m.regimeStats.length) continue
  lines.push(`### ${m.agent}`)
  lines.push(``)
  lines.push(`| Regime | Trades | Win Rate | Avg PnL | Stop Loss% | Avg Hold |`)
  lines.push(`|--------|--------|----------|---------|------------|----------|`)
  for (const r of m.regimeStats.sort((a, b) => b.count - a.count)) {
    const flag   = r.winRate < 40 ? ' ⚠' : r.winRate > 60 ? ' ✓' : ''
    const slFlag = r.stopLossRate > 50 ? ' ⚠' : ''
    lines.push(`| ${r.regime.padEnd(13)} | ${String(r.count).padStart(6)} | ${r.winRate.toFixed(1)}%${flag} | ${pct(r.avgPnl)} | ${r.stopLossRate != null ? r.stopLossRate.toFixed(0) + '%' + slFlag : 'n/a'} | ${r.avgHoldRounds != null ? r.avgHoldRounds.toFixed(1) + 'r' : 'n/a'} |`)
  }
  lines.push(``)
}

// ── Signal Accuracy ───────────────────────────────────────────────────────────
lines.push(`## Signal Accuracy`)
lines.push(``)
lines.push(`*How often did each signal correctly predict trade direction? (n = closed trades with that signal)*`)
lines.push(``)
lines.push(`| Signal | Accuracy | Sample | Assessment |`)
lines.push(`|--------|----------|--------|------------|`)
for (const s of sigAccuracy) {
  const acc = s.accuracy
  const assessment = acc == null ? 'insufficient data'
    : acc >= 60 ? '✓ predictive'
    : acc >= 50 ? '~ marginal'
    : '✗ noise'
  lines.push(`| ${s.signal.padEnd(20)} | ${acc != null ? acc.toFixed(1) + '%' : 'n/a'} | ${s.sample} | ${assessment} |`)
}
lines.push(``)

// ── Exit Reason Breakdown ─────────────────────────────────────────────────────
lines.push(`## Exit Reasons`)
lines.push(``)
lines.push(`| Agent | stop_loss | take_profit | signal_reversal | deadweight |`)
lines.push(`|-------|-----------|-------------|-----------------|------------|`)
for (const m of metrics) {
  const e = m.byExit
  lines.push(`| ${m.agent} | ${e.stop_loss || 0} | ${e.take_profit || 0} | ${e.signal_reversal || 0} | ${e.deadweight || 0} |`)
}
lines.push(``)

// ── Top Trades ────────────────────────────────────────────────────────────────
lines.push(`## Top 5 Best Trades`)
lines.push(``)
lines.push(`| Agent / Pair       | Rounds        | Held | PnL      | Regime          | Exit             | CVD context |`)
lines.push(`|--------------------|---------------|------|----------|-----------------|------------------|-------------|`)
for (const t of topTrades(5)) lines.push(tradeRow(t))
lines.push(``)

lines.push(`## Top 5 Worst Trades`)
lines.push(``)
lines.push(`| Agent / Pair       | Rounds        | Held | PnL      | Regime          | Exit             | CVD context |`)
lines.push(`|--------------------|---------------|------|----------|-----------------|------------------|-------------|`)
for (const t of worstTrades(5)) lines.push(tradeRow(t))
lines.push(``)

// ── GAMMA Short Book ──────────────────────────────────────────────────────────
lines.push(`## GAMMA Short Book`)
lines.push(``)
if (!shortMetrics) {
  lines.push(`*No closed short positions this session.*`)
} else {
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Closed shorts | ${shortMetrics.tradeCount} |`)
  lines.push(`| Win rate | ${shortMetrics.winRate.toFixed(1)}% |`)
  lines.push(`| Avg win | ${pct(shortMetrics.avgWin)} |`)
  lines.push(`| Avg loss | ${pct(shortMetrics.avgLoss)} |`)
  lines.push(`| Expectancy | ${pct(shortMetrics.expectancy)} |`)
  lines.push(`| Avg hold | ${shortMetrics.avgHold.toFixed(1)}r |`)
  lines.push(``)
  if (shortMetrics.regimeStats.length) {
    lines.push(`**By regime:**`)
    lines.push(``)
    lines.push(`| Regime | Count | Win Rate | Avg PnL | Stop Loss% | Avg Hold |`)
    lines.push(`|--------|-------|----------|---------|------------|----------|`)
    for (const r of shortMetrics.regimeStats.sort((a, b) => b.count - a.count)) {
      const flag = r.winRate < 40 ? ' ⚠' : r.winRate > 60 ? ' ✓' : ''
      lines.push(`| ${r.regime.padEnd(13)} | ${String(r.count).padStart(5)} | ${r.winRate.toFixed(1)}%${flag} | ${pct(r.avgPnl)} | ${r.stopLossRate.toFixed(0)}% | ${r.avgHoldRounds.toFixed(1)}r |`)
    }
    lines.push(``)
  }
  const e = shortMetrics.byExit
  lines.push(`Exit reasons: stop_loss=${e.stop_loss || 0}  take_profit=${e.take_profit || 0}  thesis_done=${e.thesis_done || 0}`)
  if (shortMetrics.tradeCount < 15) {
    lines.push(``)
    lines.push(`*Note: fewer than 15 closed shorts — regime Rule 10/11 proposals require ≥15 trades across ≥3 sessions.*`)
  }
}
lines.push(``)

// ── Observations ─────────────────────────────────────────────────────────────
lines.push(`## Observations`)
lines.push(``)

for (const m of metrics) {
  const badRegimes = m.regimeStats.filter(r => r.winRate < 40 && r.count >= 3)
  for (const r of badRegimes) {
    lines.push(`- **${m.agent}** entered ${r.count} ${r.regime}-regime positions; win rate was ${r.winRate}%. Consider raising buy_signal threshold in ${r.regime} markets.`)
  }
}

const cvdSig = sigAccuracy.find(s => s.signal === 'cvd_norm')
if (cvdSig?.accuracy >= 60) {
  lines.push(`- CVD was correct ${cvdSig.accuracy}% of the time — the CVD filter is working. Do not reduce its weight.`)
} else if (cvdSig?.accuracy != null && cvdSig.accuracy < 50) {
  lines.push(`- CVD accuracy was only ${cvdSig.accuracy}% this session — consider whether market conditions suppressed its signal.`)
}

for (const m of metrics) {
  const dw = m.byExit.deadweight || 0
  if (dw > 3) {
    lines.push(`- **${m.agent}** had ${dw} deadweight exits — positions held without movement. Tighter deadweight threshold may help.`)
  }
  const sl = m.byExit.stop_loss || 0
  if (sl > m.tradeCount * 0.3) {
    lines.push(`- **${m.agent}** hit stop-loss on ${sl}/${m.tradeCount} trades (${((sl / m.tradeCount) * 100).toFixed(0)}%) — entries may be mistimed or buy_signal threshold too low.`)
  }
}

if (!lines.some(l => l.startsWith('- '))) {
  lines.push(`- No strong patterns detected this session. More data needed.`)
}

lines.push(``)
lines.push(`---`)
lines.push(`*Generated by tools/report-session.js*`)

// ── Write report ──────────────────────────────────────────────────────────────
const reportFile = sessionFile.replace('.json', '.report.md')
fs.writeFileSync(reportFile, lines.join('\n'))

console.log(`✓ Report written:   ${reportFile}`)
console.log(`✓ Analysis written: ${analysisFile}`)
