'use strict'

const VERSION = '1.0.9'

require('dotenv').config()
const express             = require('express')
const { WebSocketServer } = require('ws')
const http                = require('http')
const fs                  = require('fs')
const path                = require('path')
const engine              = require('./engine')
const strategy            = require('./core/strategy')
const World               = require('./core/world')
const signals             = require('./core/signals')
const executor            = require('./core/executor')

const DEBUG         = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const SESSION_TRADES = parseInt(process.env.SESSION_TRADES) || 0
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
const LOG_TYPES   = new Set(['TRADE', 'SURVIVAL', 'WINNER', 'ERROR', 'PIPELINE', 'CANDLE'])

let eventLog = []
let pipelineRunning = false
const sellCounts = { ALPHA: 0, BETA: 0, GAMMA: 0 }

function _initSellCounts() {
  if (!SESSION_TRADES) return
  try {
    const Database = require('better-sqlite3')
    const dbPath   = require('path').join(__dirname, 'data/sim.db')
    if (!require('fs').existsSync(dbPath)) return
    const db   = new Database(dbPath, { readonly: true })
    const rows = db.prepare(
      "SELECT agent, COUNT(*) as cnt FROM ticks WHERE type='TRADE' AND agent IN ('ALPHA','BETA','GAMMA') AND json_extract(payload,'$.action')='SELL' GROUP BY agent"
    ).all()
    db.close()
    for (const r of rows) if (r.agent in sellCounts) sellCounts[r.agent] = r.cnt
    const t = sellCounts.ALPHA + sellCounts.BETA + sellCounts.GAMMA
    log(`[PIPELINE] Sell counts loaded from DB: A=${sellCounts.ALPHA} B=${sellCounts.BETA} G=${sellCounts.GAMMA}  total=${t}/${SESSION_TRADES}`)
  } catch (e) { log(`[PIPELINE] Could not init sell counts: ${e.message}`) }
}
_initSellCounts()

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
  const entry = { ts: Date.now(), ...msg }
  eventLog.push(entry)
  if (eventLog.length > MAX_LOG) eventLog.shift()
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n') } catch (_) {}
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
  broadcast({ type: 'TICK', ...snap, intervalMs, nextTickAt: lastTickAt ? lastTickAt + intervalMs : null, sellCounts: { ...sellCounts }, sessionTrades: SESSION_TRADES, realTrading: executor.REAL_TRADING, macroTrend: engine.getMacroTrend(), proposalReady: fs.existsSync(PROPOSED_FILE) })

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
  if (!result) return
  const { trade, decision } = result
  if (trade) {
    log(`[TRADE] ${result.agent || '?'} ${trade.action} ${trade.pair} $${Math.round(trade.proceeds_or_cost)} @ ${trade.price}  capital_after=$${Math.round(trade.capital_after)}`)
    if (decision && decision.enforced_reason) {
      log(`[TRADE]   ↳ enforced: ${decision.enforced_reason}`)
    }
    // Track SELL counts for auto-export threshold (increment before broadcast so TUI gets updated counts)
    if (trade.action === 'SELL' && result.agent in sellCounts && SESSION_TRADES > 0 && !pipelineRunning) {
      sellCounts[result.agent]++
      const total = sellCounts.ALPHA + sellCounts.BETA + sellCounts.GAMMA
      log(`[PIPELINE] Sell counts: A=${sellCounts.ALPHA} B=${sellCounts.BETA} G=${sellCounts.GAMMA}  total=${total}/${SESSION_TRADES}`)
      if (total >= SESSION_TRADES) {
        pipelineRunning = true
        engine.stop()
        broadcast({ type: 'PIPELINE', status: 'started', message: `${total} combined sells reached — running session analysis...` })
        _runPostSession(() => {
          sellCounts.ALPHA = 0; sellCounts.BETA = 0; sellCounts.GAMMA = 0
          pipelineRunning = false
          engine.start()
        })
      }
    }
  } else {
    dbg(`[TRADE] ${result.agent || '?'} HOLD (no trade executed)`)
  }
  if (DEBUG && decision) {
    dbg(`  reasoning: ${(decision.reasoning || '').slice(0, 120)}`)
  }
  broadcast({ type: 'TRADE', ...result, sellCounts: { ...sellCounts }, sessionTrades: SESSION_TRADES })
})

engine.emitter.on('candle', ({ interval, signals }) => {
  const btc     = signals.find(s => s.pair === 'BTCUSDT')
  const regime  = btc?.regime || '?'
  const top     = signals.slice().sort((a, b) => Math.abs(b.signal_score) - Math.abs(a.signal_score))[0]
  const topStr  = top ? `  top: ${top.pair} ${top.signal_score > 0 ? '+' : ''}${top.signal_score.toFixed(2)} [${top.regime}]` : ''
  const btcStr  = btc ? `  BTC $${Math.round(btc.price).toLocaleString()}` : ''
  const msg     = `${interval} candle closed${btcStr}  regime: ${regime}${topStr}`
  log(`[CANDLE] ${msg}`)
  broadcast({ type: 'CANDLE', interval, regime, message: msg })
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
  ws.send(JSON.stringify({ type: 'STATE', ...engine.world.getSnapshot(), intervalMs: engine.getIntervalMs(), nextTickAt: engine.getLastTickAt() ? engine.getLastTickAt() + engine.getIntervalMs() : null, realTrading: executor.REAL_TRADING, sellCounts: { ...sellCounts }, sessionTrades: SESSION_TRADES, macroTrend: engine.getMacroTrend(), proposalReady: fs.existsSync(PROPOSED_FILE) }))
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
      _broadcastProposalIfReady()
      return { ok: true }
    case 'tick':         engine.runTick();                    return { ok: true }
    case 'run_pipeline':
      if (!pipelineRunning) {
        pipelineRunning = true
        engine.stop()
        broadcast({ type: 'PIPELINE', status: 'started', message: 'Forced export — running session analysis...' })
        _runPostSession(() => {
          sellCounts.ALPHA = 0; sellCounts.BETA = 0; sellCounts.GAMMA = 0
          pipelineRunning = false
          engine.start()
        })
      }
      return { ok: true }
    case 'set_interval':    engine.setInterval_(msg.params.ms); return { ok: true }
    case 'set_real_trading': {
      const enabled = Boolean(msg.params?.enabled)
      executor.setRealTrading(enabled)
      broadcast({ type: 'TICK', ...engine.world.getSnapshot(), intervalMs: engine.getIntervalMs(), nextTickAt: null, sellCounts: { ...sellCounts }, sessionTrades: SESSION_TRADES, realTrading: executor.REAL_TRADING, macroTrend: engine.getMacroTrend(), proposalReady: fs.existsSync(PROPOSED_FILE) })
      log(`[CMD] MEGA real trading ${enabled ? 'ENABLED' : 'DISABLED'} via TUI`)
      return { ok: true }
    }
    case 'apply_change': return _applyMegaChange(msg.params?.approved)
    case 'shutdown':
      log('[SHUTDOWN] Shutdown in progress...')
      setImmediate(() => shutdown('TUI'))
      return { ok: true }
    default:
      return engine.world.applyCommand(msg)
  }
}

// ── Post-session pipeline ─────────────────────────────────────────────────────
const PROPOSED_FILE = path.join(__dirname, 'agents/mega-changes-proposed.json')
const CONFIG_FILE   = path.join(__dirname, 'agents/mega-config.json')
const HISTORY_FILE  = path.join(__dirname, 'sessions/change-history.json')

function _broadcastProposalIfReady() {
  if (!fs.existsSync(PROPOSED_FILE)) return
  try {
    const proposed = JSON.parse(fs.readFileSync(PROPOSED_FILE, 'utf8'))
    if (proposed.proposals?.length) {
      const p = proposed.proposals[0]
      broadcast({ type: 'PROPOSAL', proposal: p, sessionsAnalyzed: proposed.sessionsAnalyzed, autoApplied: true })
      log(`[PROPOSAL] Auto-applying: ${p.field} ${p.current} → ${p.proposed}`)
      _applyMegaChange(true)
    }
  } catch (_) {}
}

function _runPostSession(onDone) {
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

    _broadcastProposalIfReady()
    if (onDone) onDone()
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
    const backupTs   = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
    const backupFile = path.join(__dirname, `agents/mega-config.backup.${backupTs}.json`)
    fs.copyFileSync(CONFIG_FILE, backupFile)
    _setNestedField(megaCfg, p.field, p.proposed)
    if (p.field.startsWith('signal_weights.')) _renormalizeWeights(megaCfg)
    megaCfg.meta.version     = (megaCfg.meta.version || 1) + 1
    megaCfg.meta.lastUpdated = new Date().toISOString()
    megaCfg.meta.note        = `Updated after session ${proposed.sessionsAnalyzed} — ${p.field}: ${p.current} → ${p.proposed}`
    // Append a learning note to threat_playbook (max 6 entries)
    if (Array.isArray(megaCfg.threat_playbook)) {
      megaCfg.threat_playbook.push(
        `[v${megaCfg.meta.version}] After ${proposed.sessionsAnalyzed} sessions: ${p.field} adjusted ${p.current} → ${p.proposed}. Basis: ${p.confidence}.`
      )
      if (megaCfg.threat_playbook.length > 6) megaCfg.threat_playbook = megaCfg.threat_playbook.slice(-6)
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(megaCfg, null, 2))
    World.reloadMegaConfig()
    strategy.reloadMegaConfig()
    history.applied.push({ sessionIndex: proposed.sessionsAnalyzed, appliedAt: new Date().toISOString(), field: p.field, from: p.current, to: p.proposed, basis: p.confidence })
    const msg = `MEGA config updated (v${megaCfg.meta.version}): ${p.field} ${p.current} → ${p.proposed}`
    broadcast({ type: 'PIPELINE', status: 'done', message: msg })
    log(`[APPLY] ${msg}`)
    log(`[APPLY] Hot-reloaded mega-config into strategy + world (no restart needed)`)
  } else {
    history.rejected.push({ sessionIndex: proposed.sessionsAnalyzed, rejectedAt: new Date().toISOString(), field: p.field, proposed: p.proposed, basis: p.confidence })
    const msg = `Change rejected — ${p.field} stays at ${p.current}`
    broadcast({ type: 'PIPELINE', status: 'done', message: msg })
    log(`[APPLY] ${msg}`)
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
  // Delete proposal file so the status bar clears and P key won't re-show a stale overlay
  try { fs.unlinkSync(PROPOSED_FILE) } catch (_) {}
  return { ok: true }
}

// ── AI Assistant ──────────────────────────────────────────────────────────────
const MEGA_CONFIG_FILE = path.join(__dirname, 'agents/mega-config.json')
const C = World.C

const AI_ANSWER_SYSTEM = `You are an assistant embedded in agent-battle-gpt, a live crypto trading simulation platform.
Answer questions about the platform's metrics, agents, signals, positions, and market conditions.
Be concise and direct. Use the platform context provided to give accurate, specific answers.
Do not speculate beyond the data. If information is not in the context, say so.`

const AI_PLANNER_SYSTEM = `You are a context planner for agent-battle-gpt, a live crypto trading simulation.
Given a user question, select the minimum set of context modules needed to answer it accurately.
Reply with ONLY a valid JSON array of module names from this list — no explanation, no markdown:

agent_states        - capital, cash, holdings with unrealized P&L per agent
agent_personalities - current personality/mindset text per agent
agent_strategies    - trading thresholds, regime overrides, stop-loss config per agent
last_decisions      - most recent decision reasoning per agent (why they bought/held/sold)
trade_history       - last 10 trades with price, P&L, reasoning
market_signals      - per-pair signal scores, RSI, momentum, regime, price
macro_trend         - bull/bear market breadth across all pairs, BTC vs SMA
survival_status     - survival scores, threat status, respawn counts
session_ranking     - current standings, who is winning, sell counts
mega_config         - MEGA agent live configuration (strategy params, signal weights)`

const VALID_MODULES = new Set([
  'agent_states', 'agent_personalities', 'agent_strategies', 'last_decisions',
  'trade_history', 'market_signals', 'macro_trend', 'survival_status',
  'session_ranking', 'mega_config'
])

function _buildContextModules() {
  const snap   = engine.world.getSnapshot()
  const macro  = engine.getMacroTrend()
  const sigs   = snap.lastSignals || []
  const prices = {}
  sigs.forEach(s => { prices[s.pair] = s.price })

  const modules = {}

  // agent_states
  modules.agent_states = Object.entries(snap.agents || {}).map(([name, a]) => {
    const holdings = Object.entries(a.holdings || {})
      .filter(([, q]) => q > 0)
      .map(([p, q]) => {
        const entry = a.entryPrices?.[p]
        const px    = prices[p]
        const val   = px ? (q * px).toFixed(0) : '?'
        const pct   = (entry && px) ? ((px - entry) / entry * 100).toFixed(1) + '%' : '?'
        return `${p} val=$${val} unrealized=${pct}`
      }).join(', ') || 'none'
    const tv = a.capital + Object.entries(a.holdings || {})
      .reduce((s, [p, q]) => s + (prices[p] ? q * prices[p] : 0), 0)
    return `${name} [${a.archetype || '?'}]: total=$${tv.toFixed(0)} cash=$${a.capital.toFixed(0)} holdings=[${holdings}]`
  }).join('\n')

  // agent_personalities
  modules.agent_personalities = Object.entries(snap.agents || {})
    .map(([name, a]) => `${name}: ${a.personality || '(no personality yet)'}`)
    .join('\n\n')

  // agent_strategies
  const stratLines = ['ALPHA', 'BETA', 'GAMMA'].map(name => {
    const s = C.STRATEGY[name]
    if (!s) return `${name}: (no strategy config)`
    const overrides = Object.entries(s.regime_overrides || {})
      .map(([r, v]) => `    ${r}: ${JSON.stringify(v)}`).join('\n')
    const base = { ...s }
    delete base.regime_overrides
    return `${name} [${C.ARCHETYPES[name]?.label}]:\n  base: ${JSON.stringify(base)}\n  regime_overrides:\n${overrides}`
  })
  let megaStratStr = ''
  try {
    const cfg = JSON.parse(fs.readFileSync(MEGA_CONFIG_FILE, 'utf8'))
    megaStratStr = `MEGA [${cfg.archetype?.label || 'Autonomous'}]:\n  strategy: ${JSON.stringify(cfg.strategy)}\n  regime_overrides: ${JSON.stringify(cfg.regime_overrides)}`
  } catch (_) {}
  modules.agent_strategies = [...stratLines, megaStratStr].filter(Boolean).join('\n\n')

  // last_decisions — last DECISION tick per agent from DB
  const decisionLines = []
  try {
    const db = engine.world._db
    for (const name of ['ALPHA', 'BETA', 'GAMMA', 'MEGA']) {
      const row = db.prepare(
        "SELECT payload FROM ticks WHERE agent=? AND type='DECISION' ORDER BY id DESC LIMIT 1"
      ).get(name)
      if (row) {
        const d = JSON.parse(row.payload)
        decisionLines.push(
          `${name}: action=${d.action || '?'} pair=${d.pair || '-'} score=${d.signal_score?.toFixed(2) ?? '?'}\n  reasoning: ${d.reasoning || '(none)'}`
        )
      }
    }
  } catch (_) {}
  modules.last_decisions = decisionLines.join('\n\n') || '(no decisions yet)'

  // trade_history — last 10 TRADE ticks
  try {
    const db   = engine.world._db
    const rows = db.prepare(
      "SELECT ts, agent, payload FROM ticks WHERE type='TRADE' ORDER BY id DESC LIMIT 10"
    ).all()
    modules.trade_history = rows.map(r => {
      const t   = JSON.parse(r.payload)
      const fin = t.action === 'SELL'
        ? ` proceeds=$${t.proceeds_or_cost?.toFixed(0)}`
        : ` cost=$${t.proceeds_or_cost?.toFixed(0)}`
      return `[${new Date(r.ts).toISOString().slice(11, 19)}] ${r.agent} ${t.action} ${t.pair || '-'} qty=${t.qty?.toFixed(2) ?? '?'} @$${t.price?.toFixed(2) ?? '?'}${fin}`
    }).join('\n') || '(no trades yet)'
  } catch (_) {
    modules.trade_history = '(unavailable)'
  }

  // market_signals
  modules.market_signals = sigs.map(s =>
    `${s.pair}: score=${s.signal_score.toFixed(2)} RSI=${s.rsi_14.toFixed(0)} mom1h=${s.momentum_1h.toFixed(2)} regime=${s.regime} price=$${s.price?.toFixed(2)}`
  ).join('\n') || '(no signals yet)'

  // macro_trend
  let macroStr = 'unknown'
  if (macro?.trend) {
    const breadthStr = macro.btc !== undefined
      ? ` — ${macro.bullCount}▲ ${macro.bearCount}▼ ${macro.neutralCount}~/${macro.total} pairs`
      : ''
    const btcDetail = macro.btc ?? macro
    const btcStr = btcDetail?.pct != null
      ? `  BTC $${Math.round(btcDetail.price)} vs SMA${btcDetail.period} $${Math.round(btcDetail.sma)} (${btcDetail.pct >= 0 ? '+' : ''}${btcDetail.pct}%) slope: ${btcDetail.slopeDir}`
      : ''
    macroStr = `${macro.trend.toUpperCase()}${breadthStr}${btcStr}`
  }
  modules.macro_trend = `Round: ${snap.round}\n${macroStr}`

  // survival_status
  modules.survival_status = Object.entries(snap.agents || {}).map(([name, a]) =>
    `${name}: score=${(a.survivalScore || 0).toFixed(3)} threatened=${a.threatened || false} alive=${a.alive} respawns=${a.respawnCount} consecutiveLastPlace=${a.consecutiveLastPlace || 0}`
  ).join('\n')

  // session_ranking
  const ranked = Object.entries(snap.agents || {})
    .map(([name, a]) => {
      const tv = a.capital + Object.entries(a.holdings || {})
        .reduce((s, [p, q]) => s + (prices[p] ? q * prices[p] : 0), 0)
      return { name, tv }
    })
    .sort((a, b) => b.tv - a.tv)
  modules.session_ranking = ranked.map((r, i) =>
    `#${i + 1} ${r.name}: $${r.tv.toFixed(0)} | sells: ${sellCounts[r.name] ?? 0}`
  ).join('\n')

  // mega_config
  try {
    const cfg = JSON.parse(fs.readFileSync(MEGA_CONFIG_FILE, 'utf8'))
    modules.mega_config = `strategy: ${JSON.stringify(cfg.strategy)}\nregime_overrides: ${JSON.stringify(cfg.regime_overrides)}\nsignal_weights: ${JSON.stringify(cfg.signal_weights)}`
  } catch (_) {
    modules.mega_config = '(unavailable)'
  }

  return modules
}

app.post('/ask', checkToken, async (req, res) => {
  const question = (req.body?.question || '').trim()
  if (!question) return res.status(400).json({ ok: false, error: 'No question provided' })

  log(`[ASK] Question: "${question}"`)

  const ac = new AbortController()
  res.on('close', () => {
    if (res.writableEnded) return
    if (ac.signal.aborted) return
    log('[ASK] Client disconnected — aborting')
    ac.abort()
  })

  try {
    const openai = engine.getOpenAI()
    if (!openai) {
      log('[ASK] OpenAI not available (no API key)')
      return res.status(503).json({ ok: false, error: 'OpenAI not available (no API key)' })
    }

    // ── Step 1: context planning (gpt-4o-mini) ────────────────────────────────
    let selectedModules
    try {
      const planCompletion = await openai.chat.completions.create({
        model:       'gpt-4o-mini',
        max_tokens:  80,
        temperature: 0,
        messages: [
          { role: 'system', content: AI_PLANNER_SYSTEM },
          { role: 'user',   content: question }
        ]
      }, { signal: ac.signal })
      const raw = planCompletion.choices[0].message.content.trim()
      const parsed = JSON.parse(raw)
      selectedModules = parsed.filter(m => VALID_MODULES.has(m))
    } catch (_) {
      selectedModules = ['agent_states', 'market_signals', 'macro_trend', 'session_ranking']
    }
    if (!selectedModules.length) {
      selectedModules = ['agent_states', 'market_signals', 'macro_trend', 'session_ranking']
    }
    log(`[ASK] Modules selected: ${selectedModules.join(', ')}`)

    // ── Step 2: assemble context + answer (gpt-4o) ────────────────────────────
    const allModules = _buildContextModules()
    const contextStr = selectedModules
      .map(m => `=== ${m.toUpperCase()} ===\n${allModules[m]}`)
      .join('\n\n')
    log(`[ASK] Context size: ~${contextStr.length} chars — sending step 2`)

    const completion = await openai.chat.completions.create({
      model:      'gpt-4o',
      max_tokens: 500,
      messages: [
        { role: 'system', content: AI_ANSWER_SYSTEM + '\n\n' + contextStr },
        { role: 'user',   content: question }
      ]
    }, { signal: ac.signal })

    const answer = completion.choices[0].message.content.trim()
    log(`[ASK] Answer received (${answer.length} chars, ${completion.usage?.total_tokens ?? '?'} tokens)`)
    res.json({ answer })
  } catch (err) {
    if (ac.signal.aborted) { log('[ASK] Aborted (client cancelled)'); return }
    log(`[ASK] Error: ${err.message}`)
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message })
  }
})

server.listen(process.env.PORT || 3000, () => {
  console.log(`API listening on :${process.env.PORT || 3000}`)
  log(`[BOOT] api@${VERSION}  engine@${engine.VERSION}  world@${World.VERSION}  strategy@${strategy.VERSION}  signals@${signals.VERSION}`)
})

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal) {
  log(`[SHUTDOWN] ${signal} — stopping engine`)
  engine.stop()
  log(`[SHUTDOWN] Waiting for in-flight tick to complete...`)
  await engine.waitIdle()
  log(`[SHUTDOWN] Engine idle — terminating ${wss.clients.size} WS client(s)`)
  for (const ws of wss.clients) ws.terminate()
  log('[SHUTDOWN] Closing HTTP server')
  server.close(() => {
    log('[SHUTDOWN] Done — process exit')
    process.exit(0)
  })
  // Force exit after 5s in case server.close() hangs
  setTimeout(() => { log('[SHUTDOWN] Forced exit after timeout'); process.exit(0) }, 5000)
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
