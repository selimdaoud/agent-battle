'use strict'

require('dotenv').config()
const blessed    = require('blessed')
const wsClient   = require('./ws-client')
const agentPane  = require('./panes/agents')
const signalPane = require('./panes/signals')
const logPane    = require('./panes/log')
const ctrlPane   = require('./panes/controls')

const HOST  = process.env.ABG_HOST  || 'localhost'
const PORT  = process.env.ABG_PORT  || 3000
const TOKEN = process.env.ABG_TOKEN || process.env.WS_TOKEN || ''

// ── Screen ────────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR:    true,
  title:       'Agent Battle GPT',
  fullUnicode: true
})

// ── Layout: 60/40 horizontal, 65/35 vertical ─────────────────────────────────
const topLeft = blessed.box({
  parent: screen,
  top: 0, left: 0,
  width: '60%', height: '65%',
  label: ' AGENTS ',
  border: { type: 'line' },
  style:  { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } }
})

const topRight = blessed.box({
  parent: screen,
  top: 0, left: '60%',
  width: '40%', height: '65%'
})

const botLeft = blessed.box({
  parent: screen,
  top: '65%', left: 0,
  width: '60%', height: '35%'
})

const botRight = blessed.box({
  parent: screen,
  top: '65%', left: '60%',
  width: '40%', height: '35%'
})

// ── Mutable WS reference — passed by object so controls always uses latest ───
const clientRef = { current: null }

// ── Panes ─────────────────────────────────────────────────────────────────────
const agents   = agentPane.create(topLeft)
const signals  = signalPane.create(topRight)
const log      = logPane.create(botLeft)
const controls = ctrlPane.create(botRight, clientRef, log)

let lastPrices      = {}
let pendingDecisions = []

// ── WebSocket handlers ────────────────────────────────────────────────────────
function buildHandlers() {
  return {
    onConnect() {
      controls.onConnect()
      log.append('{green-fg}● Connected to engine{/green-fg}', 'TICK')
      screen.render()
    },
    onDisconnect(delay) {
      controls.onDisconnect()
      log.append(`{yellow-fg}○ Disconnected — retrying in ${delay / 1000}s{/yellow-fg}`, 'ERROR')
      screen.render()
    },
    onTick(snap) {
      if (snap.lastSignals && snap.lastSignals.length) {
        lastPrices = {}
        snap.lastSignals.forEach(s => { lastPrices[s.pair] = s.price })
      }
      agents.update(snap, lastPrices, pendingDecisions)
      pendingDecisions = []
      if (snap.lastSignals) signals.update(snap.lastSignals)
      log.onTick(snap)
      controls.onTick(snap)
    },
    onTrade(result) {
      if (result) pendingDecisions.push(result)
      log.onTrade(result)
    },
    onSurvival(data) {
      log.onSurvival(data)
    },
    onWinner(data) {
      log.append(`{bold}{green-fg}🏆 WINNER: ${data.agent}{/green-fg}{/bold}`, 'SURVIVAL')
      screen.render()
    },
    onError(data) {
      log.onError(data)
    }
  }
}

function connect() {
  if (clientRef.current) clientRef.current.destroy()
  clientRef.current = wsClient.connect(HOST, PORT, TOKEN, buildHandlers())
}

// ── Keyboard input ────────────────────────────────────────────────────────────
screen.on('keypress', (ch, key) => {
  controls.handleKey(screen, ch, key, {
    toggleSignals: () => signals.toggleCompact(),
    cycleLog:      () => log.cycleFilter(),
    reconnect:     () => connect()
  })
})

screen.key(['escape', 'C-c'], () => { screen.destroy(); process.exit(0) })

// ── Boot ──────────────────────────────────────────────────────────────────────
connect()
screen.render()
log.append(`{cyan-fg}Connecting to ${HOST}:${PORT}...{/cyan-fg}`, 'TICK')
