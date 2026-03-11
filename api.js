'use strict'

require('dotenv').config()
const express             = require('express')
const { WebSocketServer } = require('ws')
const http                = require('http')
const fs                  = require('fs')
const path                = require('path')
const engine              = require('./engine')

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const log   = (...args) => console.log(new Date().toISOString(), ...args)
const dbg   = (...args) => { if (DEBUG) console.log('[DBG]', new Date().toISOString(), ...args) }

const app    = express()
const server = http.createServer(app)
const wss    = new WebSocketServer({ server })
const TOKEN  = process.env.WS_TOKEN

app.use(express.json())
app.use(express.static('public'))

// ── Event log (persisted to disk, replayed to new TUI connections) ────────────
const LOG_FILE    = path.join(__dirname, 'sessions/events.jsonl')
const MAX_LOG     = 500
const LOG_TYPES   = new Set(['TRADE', 'SURVIVAL', 'WINNER', 'ERROR', 'PIPELINE'])

let eventLog = []

function _loadEventLog() {
  if (!fs.existsSync(LOG_FILE)) return
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean)
    eventLog = lines.slice(-MAX_LOG).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    // Rewrite trimmed file
    fs.writeFileSync(LOG_FILE, eventLog.map(e => JSON.stringify(e)).join('\n') + '\n')
  } catch (_) {}
}
_loadEventLog()

function _appendEventLog(msg) {
  eventLog.push(msg)
  if (eventLog.length > MAX_LOG) eventLog.shift()
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(msg) + '\n') } catch (_) {}
}

// ── Broadcast helper ──────────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === 1 && c.authed) c.send(str) })
  if (LOG_TYPES.has(msg.type)) {
    // Don't persist transient PIPELINE statuses — they'd replay as stale "analysis running" on reconnect
    if (msg.type === 'PIPELINE' && msg.status !== 'done' && msg.status !== 'error') return
    _appendEventLog(msg)
  }
}

// ── Subscribe to engine events ────────────────────────────────────────────────
engine.emitter.on('tick', snap => {
  const intervalMs = engine.getIntervalMs()
  const lastTickAt = engine.getLastTickAt()
  broadcast({ type: 'TICK', ...snap, intervalMs, nextTickAt: lastTickAt ? lastTickAt + intervalMs : null })

  const agents = Object.values(snap.agents)
    .map(a => `${a.name} $${Math.round(a.capital)} pos:${Object.keys(a.holdings).length} score:${a.survivalScore.toFixed(3)}`)
    .join('  |  ')
  log(`[TICK] round=${snap.round}  running=${snap.running}  ${agents}`)

  if (DEBUG) {
    Object.values(snap.agents).forEach(a => {
      dbg(`  ${a.name} | alive:${a.alive} threatened:${a.threatened} respawns:${a.respawnCount}`)
      dbg(`  ${a.name} | personality: ${a.personality || '(none)'}`)
      const holds = Object.entries(a.holdings).map(([p, q]) => `${p}:${q.toFixed(4)}`).join(', ')
      if (holds) dbg(`  ${a.name} | holdings: ${holds}`)
    })
    if (snap.lastSignals && snap.lastSignals.length) {
      const top = snap.lastSignals
        .slice()
        .sort((a, b) => Math.abs(b.signal_score) - Math.abs(a.signal_score))
        .slice(0, 5)
      dbg('  Top signals:', top.map(s => `${s.pair}=${s.signal_score.toFixed(3)} [${s.regime}]`).join('  '))
    }
  }
})

engine.emitter.on('trade', result => {
  broadcast({ type: 'TRADE', ...result })
  if (!result) return
  const { trade, decision } = result
  if (trade) {
    log(`[TRADE] ${result.agent || '?'} ${trade.action} ${trade.pair} $${Math.round(trade.proceeds_or_cost)} @ ${trade.price}  capital_after=$${Math.round(trade.capital_after)}`)
    if (decision && decision.enforced_reason) {
      log(`[TRADE]   ↳ enforced: ${decision.enforced_reason}`)
    }
  } else {
    dbg(`[TRADE] ${result.agent || '?'} HOLD (no trade executed)`)
  }
  if (DEBUG && decision) {
    dbg(`  reasoning: ${(decision.reasoning || '').slice(0, 120)}`)
  }
})

engine.emitter.on('winner', name => {
  broadcast({ type: 'WINNER', agent: name })
  log(`[WINNER] ${name}`)
})

engine.emitter.on('error', message => {
  broadcast({ type: 'ERROR', message })
  console.error(`[ERROR] ${message}`)
})

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  dbg(`[WS] client connected from ${req.socket.remoteAddress}`)
  ws.authed = false
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.token !== TOKEN) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Unauthorized' }))
      return
    }
    if (msg.type === 'AUTH') { ws.authed = true; return }
    if (!ws.authed) return

    if (msg.type === 'COMMAND') handleCommand(msg, ws)
  })
  ws.send(JSON.stringify({ type: 'STATE', ...engine.world.getSnapshot() }))
  if (eventLog.length) ws.send(JSON.stringify({ type: 'LOG_HISTORY', events: eventLog }))
})

// ── REST endpoints ────────────────────────────────────────────────────────────
function checkToken(req, res, next) {
  if (req.body?.token !== TOKEN) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

app.get('/state',   (req, res) => res.json(engine.world.getSnapshot()))
app.get('/history', (req, res) => res.json(engine.world.getRecentTicks(req.query.limit || 100)))
app.get('/signals', (req, res) => res.json(engine.world.getSnapshot().lastSignals))

app.post('/command', checkToken, (req, res) => {
  const result = handleCommand(req.body)
  res.json(result)
})

// ── Command handler ───────────────────────────────────────────────────────────
function handleCommand(msg) {
  dbg(`[CMD] ${msg.command}${msg.agent ? ' agent=' + msg.agent : ''}${msg.params ? ' params=' + JSON.stringify(msg.params) : ''}`)
  switch (msg.command) {
    case 'start':        engine.start();                      return { ok: true }
    case 'stop':
      engine.stop()
      broadcast({ type: 'PIPELINE', status: 'started', message: 'Session analysis running...' })
      _runPostSession()
      return { ok: true }
    case 'tick':         engine.runTick();                    return { ok: true }
    case 'set_interval': engine.setInterval_(msg.params.ms); return { ok: true }
    case 'apply_change': return _applyMegaChange(msg.params?.approved)
    default:
      return engine.world.applyCommand(msg)
  }
}

// ── Post-session pipeline ─────────────────────────────────────────────────────
const PROPOSED_FILE = path.join(__dirname, 'agents/mega-changes-proposed.json')
const CONFIG_FILE   = path.join(__dirname, 'agents/mega-config.json')
const HISTORY_FILE  = path.join(__dirname, 'sessions/change-history.json')

function _runPostSession() {
  const { spawn } = require('child_process')
  const child     = spawn(process.execPath, [path.join(__dirname, 'tools/post-session.js')], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', d => { output += d.toString() })
  child.stderr.on('data', d => { output += d.toString() })
  child.on('close', code => {
    const lines   = output.trim().split('\n').filter(l => l && !l.startsWith('──'))
    const summary = lines[lines.length - 1] || 'Analysis complete'
    lines.slice(0, -1).forEach(l => broadcast({ type: 'PIPELINE', status: 'log', message: l }))
    broadcast({ type: 'PIPELINE', status: code === 0 ? 'done' : 'error', message: summary })
    log(`[PIPELINE] ${summary}`)

    // If a proposal was written, broadcast it so the TUI can display it
    if (code === 0 && fs.existsSync(PROPOSED_FILE)) {
      try {
        const proposed = JSON.parse(fs.readFileSync(PROPOSED_FILE, 'utf8'))
        if (proposed.proposals?.length) {
          broadcast({ type: 'PROPOSAL', proposal: proposed.proposals[0], sessionsAnalyzed: proposed.sessionsAnalyzed })
          log('[PIPELINE] Proposal broadcast to TUI')
        }
      } catch (_) {}
    }
  })
}

// ── MEGA config apply/reject ───────────────────────────────────────────────────
function _setNestedField(obj, dotPath, value) {
  const keys = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

function _renormalizeWeights(cfg) {
  const w     = cfg.signal_weights
  const total = Object.values(w).reduce((s, v) => s + v, 0)
  if (Math.abs(total - 1.0) < 0.001) return
  for (const k of Object.keys(w)) w[k] = parseFloat((w[k] / total).toFixed(4))
}

function _applyMegaChange(approved) {
  if (!fs.existsSync(PROPOSED_FILE)) return { ok: false, message: 'No proposal file found' }

  const proposed = JSON.parse(fs.readFileSync(PROPOSED_FILE, 'utf8'))
  const p        = proposed.proposals?.[0]
  if (!p) return { ok: false, message: 'Proposal file is empty' }

  const megaCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  const history = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : { applied: [], rejected: [] }

  if (approved) {
    _setNestedField(megaCfg, p.field, p.proposed)
    if (p.field.startsWith('signal_weights.')) _renormalizeWeights(megaCfg)
    megaCfg.meta.version     = (megaCfg.meta.version || 1) + 1
    megaCfg.meta.lastUpdated = new Date().toISOString()
    megaCfg.meta.note        = `Updated after session ${proposed.sessionsAnalyzed} — ${p.field}: ${p.current} → ${p.proposed}`
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(megaCfg, null, 2))
    history.applied.push({ sessionIndex: proposed.sessionsAnalyzed, appliedAt: new Date().toISOString(), field: p.field, from: p.current, to: p.proposed, basis: p.confidence })
    const msg = `MEGA config updated (v${megaCfg.meta.version}): ${p.field} ${p.current} → ${p.proposed}`
    broadcast({ type: 'PIPELINE', status: 'done', message: msg })
    log(`[APPLY] ${msg}`)
  } else {
    history.rejected.push({ sessionIndex: proposed.sessionsAnalyzed, rejectedAt: new Date().toISOString(), field: p.field, proposed: p.proposed, basis: p.confidence })
    const msg = `Change rejected — ${p.field} stays at ${p.current}`
    broadcast({ type: 'PIPELINE', status: 'done', message: msg })
    log(`[APPLY] ${msg}`)
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
  return { ok: true }
}

server.listen(process.env.PORT || 3000, () =>
  console.log(`API listening on :${process.env.PORT || 3000}`))
