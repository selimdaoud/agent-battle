'use strict'

/**
 * tools/export-session.js
 *
 * Reads sim.db and produces a structured session JSON file:
 *   sessions/session-<ISO-timestamp>.json
 *   sessions/session-<ISO-timestamp>.meta.json
 *
 * Usage: node tools/export-session.js [--db <path>] [--out <dir>]
 */

const Database = require('better-sqlite3')
const fs       = require('fs')
const path     = require('path')
const { C }    = require('../core/world')

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2)
const dbPath  = args[args.indexOf('--db')  + 1] || path.join(__dirname, '../data/sim.db')
const outDir  = args[args.indexOf('--out') + 1] || path.join(__dirname, '../sessions')

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

// ── Open DB ───────────────────────────────────────────────────────────────────
const db = new Database(dbPath, { readonly: true })

const roundRow = db.prepare("SELECT value FROM config WHERE key='current_round'").get()
const totalRounds = roundRow ? parseInt(roundRow.value, 10) : 0

const allTicks = db.prepare('SELECT * FROM ticks ORDER BY id ASC').all()
  .map(r => ({ ...r, payload: JSON.parse(r.payload) }))

// ── Build signal index: round → pair → signal data ───────────────────────────
const signalIndex = {}
for (const t of allTicks) {
  if (t.type !== 'SIGNAL') continue
  const r = t.round
  if (!signalIndex[r]) signalIndex[r] = {}
  signalIndex[r][t.payload.pair] = t.payload
}

function signalAt(round, pair) {
  return signalIndex[round]?.[pair] || null
}

function regimeAt(round) {
  const sigs = signalIndex[round]
  if (!sigs) return null
  const first = Object.values(sigs)[0]
  return first?.regime || null
}

function cvdAt(round, pair) {
  return signalIndex[round]?.[pair]?.cvd_norm ?? null
}

function fearGreedAt(round) {
  const sigs = signalIndex[round]
  if (!sigs) return null
  const first = Object.values(sigs)[0]
  return first?.fear_greed ?? null
}

// ── Build decision index: agent → round → decision ───────────────────────────
const decisionIndex = {}
for (const t of allTicks) {
  if (t.type !== 'DECISION') continue
  const key = `${t.agent}:${t.round}:${t.payload.pair}`
  decisionIndex[key] = t.payload
}

// ── Build closed trade records ────────────────────────────────────────────────
function buildClosedTrades() {
  // Track open positions per agent: { agent: { pair: { entryRound, entryPrice, entrySignal... } } }
  const openPositions = {}
  const closedTrades  = []

  for (const t of allTicks) {
    if (t.type !== 'TRADE') continue
    const { agent, round, payload: trade } = t
    const { action, pair, price, qty, capital_after } = trade

    if (!openPositions[agent]) openPositions[agent] = {}

    if (action === 'BUY') {
      const sig = signalAt(round, pair)
      openPositions[agent][pair] = {
        entryRound:       round,
        entryPrice:       price,
        qty,
        signalAtEntry:    sig?.signal_score   ?? null,
        regimeAtEntry:    sig?.regime          ?? null,
        cvdAtEntry:       sig?.cvd_norm        ?? null,
        fearGreedAtEntry: sig?.fear_greed      ?? null,
        fundingAtEntry:   sig?.funding_signal  ?? null,
      }
    } else if (action === 'SELL') {
      const open = openPositions[agent]?.[pair]
      if (!open) continue

      const pnlPct = open.entryPrice > 0
        ? ((price - open.entryPrice) / open.entryPrice) * 100
        : null

      // Determine exit reason
      const decKey  = `${agent}:${round}:${pair}`
      const dec     = decisionIndex[decKey]
      let exitReason = 'signal_reversal'
      if (trade.enforced_reason === 'stop_loss') {
        exitReason = 'stop_loss'
      } else if (dec?.enforced_reason === 'stop_loss') {
        exitReason = 'stop_loss'
      } else if (dec?.reasoning?.includes('deadweight')) {
        exitReason = 'deadweight'
      } else if (dec?.reasoning?.includes('profit target') || dec?.reasoning?.includes('take_profit')) {
        exitReason = 'take_profit'
      } else if (pnlPct > 0) {
        exitReason = 'take_profit'
      }

      closedTrades.push({
        agent,
        pair,
        entryRound:       open.entryRound,
        exitRound:        round,
        roundsHeld:       round - open.entryRound,
        entryPrice:       open.entryPrice,
        exitPrice:        price,
        qty:              open.qty,
        realizedPnlPct:   pnlPct !== null ? parseFloat(pnlPct.toFixed(4)) : null,
        fees:             parseFloat(((open.qty * open.entryPrice + qty * price) * C.TAKER_FEE_PCT).toFixed(6)),
        signalAtEntry:    open.signalAtEntry,
        regimeAtEntry:    open.regimeAtEntry,
        cvdAtEntry:       open.cvdAtEntry,
        fearGreedAtEntry: open.fearGreedAtEntry,
        fundingAtEntry:   open.fundingAtEntry,
        exitReason
      })

      delete openPositions[agent][pair]
    }
  }

  return closedTrades
}

// ── Build survival events ─────────────────────────────────────────────────────
function buildSurvivalEvents() {
  return allTicks
    .filter(t => t.type === 'SURVIVAL')
    .map(t => ({
      round:      t.round,
      agent:      t.agent,
      event_type: t.payload.event_type,
      reason:     t.payload.reason,
      new_status: t.payload.new_status
    }))
}

// ── Build decisions summary ───────────────────────────────────────────────────
function buildDecisions() {
  return allTicks
    .filter(t => t.type === 'DECISION')
    .map(t => ({
      round:         t.round,
      agent:         t.agent,
      action:        t.payload.action,
      pair:          t.payload.pair,
      amount_usd:    t.payload.amount_usd,
      signal_score:  t.payload.signal_score,
      enforced:      !!t.payload.enforced_reason,
      enforced_reason: t.payload.enforced_reason || null
    }))
}

// ── Compute per-agent final state ─────────────────────────────────────────────
function buildAgentSummary() {
  const summary = {}
  for (const name of ['ALPHA', 'BETA', 'GAMMA', 'MEGA']) {
    const tradeTicks = allTicks.filter(t => t.type === 'TRADE' && t.agent === name)
    const survTicks  = allTicks.filter(t => t.type === 'SURVIVAL' && t.agent === name)
    summary[name] = {
      totalTrades:      tradeTicks.filter(t => t.payload.action === 'BUY').length,
      totalFees:        parseFloat(tradeTicks.reduce((s, t) => s + (t.payload.fee || 0), 0).toFixed(4)),
      eliminations:     survTicks.filter(t => t.payload.event_type === 'AUTO_ELIMINATE').length,
      respawns:         survTicks.filter(t => t.payload.event_type === 'AUTO_RESPAWN').length,
      threats:          survTicks.filter(t => t.payload.event_type === 'AUTO_THREATEN').length,
    }
  }
  return summary
}

// ── Assemble and write ────────────────────────────────────────────────────────
const closedTrades    = buildClosedTrades()
const survivalEvents  = buildSurvivalEvents()
const decisions       = buildDecisions()
const agentSummary    = buildAgentSummary()

// Timestamps
const firstTick = allTicks[0]
const lastTick  = allTicks[allTicks.length - 1]
const startTs   = firstTick?.ts || Date.now()
const endTs     = lastTick?.ts  || Date.now()
const sessionId = `session-${new Date(startTs).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`

const session = {
  meta: {
    sessionId,
    exportedAt:   new Date().toISOString(),
    startTs,
    endTs,
    durationHours: parseFloat(((endTs - startTs) / 3_600_000).toFixed(2)),
    totalRounds
  },
  agentSummary,
  closedTrades,
  survivalEvents,
  decisions
}

// Meta summary (lightweight header)
const meta = {
  sessionId:    session.meta.sessionId,
  exportedAt:   session.meta.exportedAt,
  totalRounds,
  durationHours: session.meta.durationHours,
  closedTradeCount: closedTrades.length,
  agents: Object.fromEntries(
    Object.entries(agentSummary).map(([name, s]) => [name, {
      trades: s.totalTrades,
      eliminations: s.eliminations
    }])
  )
}

const sessionFile = path.join(outDir, `${sessionId}.json`)
const metaFile    = path.join(outDir, `${sessionId}.meta.json`)

fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2))
fs.writeFileSync(metaFile,    JSON.stringify(meta,    null, 2))

console.log(`✓ Session exported: ${sessionFile}`)
console.log(`  ${closedTrades.length} closed trades across ${totalRounds} rounds (${session.meta.durationHours}h)`)
console.log(`  Meta: ${metaFile}`)

module.exports = { sessionId, sessionFile }
