'use strict'

require('dotenv').config()

const express = require('express')
const engine  = require('./engine')

const API_PORT = parseInt(process.env.API_PORT) || 3002

const app = express()
app.use(express.json())

const log = (...args) => process.stdout.write(new Date().toISOString() + ' [API] ' + args.join(' ') + '\n')

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, candleCount: engine.getCandleCount(), uptime: process.uptime() })
})

// ── GET /state ────────────────────────────────────────────────────────────────
// Current snapshot: agents + last signal vectors

app.get('/state', (_req, res) => {
  const signals = engine.getCachedSignals() || []
  const prices  = Object.fromEntries(
    Object.entries(engine.getPriceHistories()).map(([p, h]) => [p, h.length ? h[h.length - 1] : 0])
  )
  const agents = engine.getAgentPool().map(a => a.snapshot(prices))
  res.json({ candleCount: engine.getCandleCount(), signals, agents })
})

// ── GET /events ───────────────────────────────────────────────────────────────
// Query params: type, agent_id, pair, mode, from_ts, to_ts, config_version, limit, order

app.get('/events', (req, res) => {
  const { type = 'exit', agent_id, pair, mode, from_ts, to_ts, config_version, limit, order } = req.query
  try {
    const rows = engine.store.query(type, {
      agent_id,
      pair,
      mode,
      from_ts:        from_ts        ? parseInt(from_ts)        : undefined,
      to_ts:          to_ts          ? parseInt(to_ts)          : undefined,
      config_version: config_version ? parseInt(config_version) : undefined,
      limit:          limit          ? parseInt(limit)          : 200,
      order:          order || 'desc'
    })
    res.json(rows)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── GET /config/:id ───────────────────────────────────────────────────────────

app.get('/config/:id', (req, res) => {
  const { id } = req.params
  const config  = engine.configStore.getConfig(id)
  const version = engine.configStore.getVersion(id)
  if (!config) return res.status(404).json({ error: 'agent not found' })
  res.json({ id, version, config })
})

// ── POST /config/:id ──────────────────────────────────────────────────────────
// Body: { config: {...}, reason: "..." }
// Operator override — hot-reloaded by engine automatically via fs.watch

app.post('/config/:id', (req, res) => {
  const { id }    = req.params
  const { config, reason = 'manual override via API' } = req.body
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'body.config is required' })
  }
  try {
    const newVersion = engine.configStore.setConfig(id, config, reason)
    log(`config updated  agent=${id}  v${newVersion}  reason="${reason}"`)
    res.json({ id, version: newVersion })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /agents ───────────────────────────────────────────────────────────────

app.get('/agents', (_req, res) => {
  res.json(engine.configStore.listAgents())
})

// ── POST /adapt/trigger ───────────────────────────────────────────────────────
// Force an immediate adaptation cycle for all agents.

app.post('/adapt/trigger', async (_req, res) => {
  const ae = engine.getAdaptationEngine()
  if (!ae) return res.status(503).json({ error: 'adaptation engine not running' })
  try {
    await ae.poll()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /adapt/reset/:id ─────────────────────────────────────────────────────
// Reset Thompson Sampling posteriors for one agent (or all if :id === 'all').

app.post('/adapt/reset/:id', (req, res) => {
  const ae = engine.getAdaptationEngine()
  if (!ae) return res.status(503).json({ error: 'adaptation engine not running' })
  const { id } = req.params
  const targets = id === 'all' ? engine.configStore.listAgents() : [id]
  for (const agentId of targets) ae.resetAgent(agentId)
  log(`posteriors reset  targets=${targets.join(',')}`)
  res.json({ ok: true, reset: targets })
})

// ── Boot ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  engine.start().then(() => {
    app.listen(API_PORT, () => log(`REST API listening  port=${API_PORT}`))

    process.on('SIGINT',  () => { engine.stop(); engine.store.close(); process.exit(0) })
    process.on('SIGTERM', () => { engine.stop(); engine.store.close(); process.exit(0) })
  }).catch(err => {
    log('fatal:', err.message)
    process.exit(1)
  })
}

module.exports = app
