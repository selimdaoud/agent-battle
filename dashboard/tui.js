'use strict'

const VERSION = '1.0.0'

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

// ── Layout: 70/30 horizontal, 65/35 vertical ─────────────────────────────────
const topLeft = blessed.box({
  parent: screen,
  top: 0, left: 0,
  width: '70%', height: '65%',
  label: ' AGENTS ',
  border: { type: 'line' },
  style:  { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } }
})

const topRight = blessed.box({
  parent: screen,
  top: 0, left: '70%',
  width: '30%', height: '65%'
})

const botLeft = blessed.box({
  parent: screen,
  top: '65%', left: 0,
  width: '70%', height: '35%'
})

const botRight = blessed.box({
  parent: screen,
  top: '65%', left: '70%',
  width: '30%', height: '35%'
})

// ── Proposal overlay ──────────────────────────────────────────────────────────
const proposalBox = blessed.box({
  parent:  screen,
  top:     'center',
  left:    'center',
  width:   '72%',
  height:  '65%',
  label:   ' ★ MEGA CONFIG PROPOSAL ',
  border:  { type: 'line' },
  style:   { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true }, bg: 'black' },
  tags:    true,
  hidden:  true,
  scrollable: true,
  alwaysScroll: true,
  keys: true
})

function showProposal(data) {
  const p = data.proposal
  if (!p) return

  const wrap = (text, width = 64) => {
    const words = text.split(' ')
    const lines = []
    let line = ''
    for (const word of words) {
      if (line.length + word.length + 1 > width) { lines.push(line.trimEnd()); line = '' }
      line += word + ' '
    }
    if (line.trim()) lines.push(line.trimEnd())
    return lines.join('\n')
  }

  const deferred = p.deferred?.length
    ? `\n{grey-fg}Deferred → ${p.deferred.map(d => d.field).join(', ')}{/grey-fg}`
    : ''

  proposalBox.setContent(
    `{yellow-fg}{bold}Field:{/bold}{/yellow-fg}    ${p.field}\n` +
    `{yellow-fg}{bold}Current:{/bold}{/yellow-fg}  {red-fg}${p.current}{/red-fg}   {yellow-fg}{bold}Proposed:{/bold}{/yellow-fg}  {green-fg}${p.proposed}{/green-fg}\n` +
    `{yellow-fg}{bold}Basis:{/bold}{/yellow-fg}    ${p.confidence}\n` +
    `\n` +
    `{white-fg}${wrap(p.justification)}{/white-fg}` +
    deferred +
    `\n\n${'─'.repeat(60)}\n` +
    `  {green-fg}{bold}[Y]{/bold}{/green-fg} Apply change    {red-fg}{bold}[N]{/bold}{/red-fg} Reject`
  )
  proposalBox.show()
  proposalBox.setFront()
  screen.render()
}

// ── Mutable WS reference — passed by object so controls always uses latest ───
const clientRef = { current: null }

// ── Panes ─────────────────────────────────────────────────────────────────────
const agents   = agentPane.create(topLeft)
const signals  = signalPane.create(topRight)
const log      = logPane.create(botLeft)
const controls = ctrlPane.create(botRight, clientRef, log, screen)

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
      controls.onTrade(result)
    },
    onCandle(data) {
      log.onCandle(data)
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
    },
    onPipeline(data) {
      if (data.status === 'started') {
        log.append('{cyan-fg}⟳ Session analysis running...{/cyan-fg}', 'TICK')
      } else if (data.status === 'log') {
        log.append(`{grey-fg}${data.message}{/grey-fg}`, 'TICK')
      } else if (data.status === 'done') {
        log.append(`{green-fg}✓ ${data.message}{/green-fg}`, 'TICK')
      } else {
        log.append(`{red-fg}✗ Analysis error: ${data.message}{/red-fg}`, 'ERROR')
      }
      screen.render()
    },
    onProposal(data) {
      log.append('{yellow-fg}★ MEGA config proposal ready — review overlay{/yellow-fg}', 'TICK')
      showProposal(data)
    },
    onLogHistory(data) {
      const handlers = this
      log.clear()
      for (const ev of (data.events || [])) {
        switch (ev.type) {
          case 'TRADE':    log.onTrade(ev);    break
          case 'SURVIVAL': log.onSurvival(ev); break
          case 'WINNER':   log.append(`{bold}{green-fg}🏆 WINNER: ${ev.agent}{/green-fg}{/bold}`, 'SURVIVAL'); break
          case 'ERROR':    log.onError(ev);    break
          case 'PIPELINE': handlers.onPipeline(ev); break
          case 'CANDLE':   log.onCandle(ev);   break
        }
      }
      screen.render()
    }
  }
}

function connect() {
  if (clientRef.current) clientRef.current.destroy()
  clientRef.current = wsClient.connect(HOST, PORT, TOKEN, buildHandlers())
}

// ── Keyboard input ────────────────────────────────────────────────────────────
screen.on('keypress', (ch, key) => {
  // Proposal overlay intercepts Y/N when visible
  if (!proposalBox.hidden) {
    if (ch === 'y' || ch === 'Y') {
      clientRef.current?.send({ type: 'COMMAND', command: 'apply_change', params: { approved: true } })
      proposalBox.hide()
      screen.render()
    } else if (ch === 'n' || ch === 'N') {
      clientRef.current?.send({ type: 'COMMAND', command: 'apply_change', params: { approved: false } })
      proposalBox.hide()
      screen.render()
    }
    return
  }
  controls.handleKey(screen, ch, key, {
    toggleSignals:   () => signals.toggleCompact(),
    cycleLog:        () => log.cycleFilter(),
    cycleAgentFilter:() => log.cycleAgentFilter(),
    reconnect:       () => connect()
  })
})

screen.key(['escape', 'C-c'], () => { screen.destroy(); process.exit(0) })

// ── Boot ──────────────────────────────────────────────────────────────────────
connect()
screen.render()
log.append(`{grey-fg}versions — tui@${VERSION}  log@${logPane.VERSION}  controls@${ctrlPane.VERSION}{/grey-fg}`, 'TICK')
log.append(`{cyan-fg}Connecting to ${HOST}:${PORT}...{/cyan-fg}`, 'TICK')
