'use strict'

require('dotenv').config()
const express             = require('express')
const { WebSocketServer } = require('ws')
const http                = require('http')
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

// ── Broadcast helper ──────────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === 1 && c.authed) c.send(str) })
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
    case 'stop':         engine.stop();                       return { ok: true }
    case 'tick':         engine.runTick();                    return { ok: true }
    case 'set_interval': engine.setInterval_(msg.params.ms); return { ok: true }
    default:
      return engine.world.applyCommand(msg)
  }
}

server.listen(process.env.PORT || 3000, () =>
  console.log(`API listening on :${process.env.PORT || 3000}`))
