'use strict'

require('dotenv').config()

const blessed  = require('blessed')
const wsClient = require('./ws-client')

const poolPane       = require('./panes/pool')
const signalsPane    = require('./panes/signals')
const adaptationPane = require('./panes/adaptation')
const newsPane       = require('./panes/news')
const performancePane = require('./panes/performance')
const logPane        = require('./panes/log')
const controlsPane   = require('./panes/controls')

const HOST  = process.env.ABG_HOST  || 'localhost'
const PORT  = parseInt(process.env.PORT) || 3001
const TOKEN = process.env.WS_TOKEN  || ''

// ── Screen ────────────────────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR:    true,
  title:       'agent-battle-gpt v2',
  fullUnicode: true
})

// ── Layout ────────────────────────────────────────────────────────────────────
//
//  ┌──────────────────┬──────────────┬─────────────┐
//  │  POOL (40%)      │ SIGNALS(30%) │ ADAPT (30%) │  60%
//  │                  ├──────────────┤             │
//  │                  │ NEWS         │             │
//  ├──────────────────┴──────────────┴─────────────┤
//  │  LOG                                          │  22%
//  ├──────────────────────────────┬────────────────┤
//  │  PERFORMANCE (65%)           │ CONTROLS (35%) │  18%
//  └──────────────────────────────┴────────────────┘

const topRow = blessed.box({
  parent: screen,
  top: 0, left: 0,
  width: '100%', height: '60%'
})

const poolBox = blessed.box({
  parent: topRow,
  top: 0, left: 0,
  width: '40%', height: '100%',
  label: ' POOL ',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } }
})

const signalsBox = blessed.box({
  parent: topRow,
  top: 0, left: '40%',
  width: '30%', height: '50%',
  label: ' SIGNALS ',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } }
})

const newsBox = blessed.box({
  parent: topRow,
  top: '50%', left: '40%',
  width: '30%', height: '50%',
  label: ' NEWS ',
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } }
})

const adaptBox = blessed.box({
  parent: topRow,
  top: 0, left: '70%',
  width: '30%', height: '100%',
  label: ' ADAPTATION ',
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } }
})

const logBox = blessed.box({
  parent: screen,
  top: '60%', left: 0,
  width: '100%', height: '22%'
})

const perfBox = blessed.box({
  parent: screen,
  top: '82%', left: 0,
  width: '65%', height: '18%',
  label: ' PERFORMANCE ',
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } }
})

const ctrlBox = blessed.box({
  parent: screen,
  top: '82%', left: '65%',
  width: '35%', height: '18%',
  label: ' STATUS ',
  border: { type: 'line' },
  style: { border: { fg: 'grey' }, label: { fg: 'grey' } }
})

// ── Pane instances ────────────────────────────────────────────────────────────

const pool       = poolPane.create(poolBox)
const signals    = signalsPane.create(signalsBox)
const adaptation = adaptationPane.create(adaptBox)
const news       = newsPane.create(newsBox)
const perf       = performancePane.create(perfBox)
const log        = logPane.create(logBox)
const controls   = controlsPane.create(ctrlBox, screen)

// ── News overlay ──────────────────────────────────────────────────────────────

const _newsHistory = []  // full event objects, newest last

const newsOverlay = blessed.box({
  parent:  screen,
  top:     '5%', left: '5%',
  width:   '90%', height: '90%',
  label:   ' NEWS FEED  (↑/↓ scroll · N or Esc to close) ',
  tags:    true,
  hidden:  true,
  border:  { type: 'line' },
  scrollable:  true,
  alwaysScroll: true,
  keys:    true,
  mouse:   true,
  style: {
    bg:     'black',
    fg:     'white',
    border: { fg: 'magenta', bg: 'black' },
    label:  { fg: 'magenta', bg: 'black', bold: true },
    scrollbar: { bg: 'magenta' }
  }
})

// ── DXY overlay ───────────────────────────────────────────────────────────────

let _macroSignal = null

const dxyOverlay = blessed.box({
  parent:  screen,
  top:     '20%', left: '25%',
  width:   '50%', height: '55%',
  label:   ' DXY MACRO SIGNAL  [R] refresh · [P] pause · [G] resume · [Esc/D] close ',
  tags:    true,
  hidden:  true,
  keys:    true,
  border:  { type: 'line' },
  style: {
    bg:     'black',
    fg:     'white',
    border: { fg: 'cyan', bg: 'black' },
    label:  { fg: 'cyan', bg: 'black', bold: true }
  }
})

function renderDxyOverlay() {
  if (!_macroSignal || _macroSignal.dxy == null) {
    dxyOverlay.setContent('{grey-fg}No DXY data yet. Press [R] to fetch.{/grey-fg}')
    return
  }
  const { dxy, latestDate, sma10w, sma20w, trend, advice, trading_paused, updatedAt } = _macroSignal
  const age     = updatedAt ? Math.round((Date.now() - updatedAt) / 3600000) : '?'
  const trendClr = trend === 'falling' ? '{green-fg}' : '{red-fg}'
  const trendTxt = trend === 'falling'
    ? '{green-fg}↓ FALLING  (dollar weakening — bullish for crypto){/green-fg}'
    : '{red-fg}↑ RISING   (dollar strengthening — bearish for crypto){/red-fg}'
  const adviceBlock = advice === 'green' && !trading_paused
    ? '{green-fg}⬤  TRADE NORMALLY{/green-fg}\n   Short SMA < Long SMA — macro regime supports trading.'
    : trading_paused
    ? '{red-fg}⬤  ENTRIES PAUSED (manual override){/red-fg}\n   Press [G] to resume.'
    : '{yellow-fg}⬤  CAUTION — consider pausing new entries{/yellow-fg}\n   Dollar strengthening. Press [P] to pause.'

  const lines = [
    '',
    `  {white-fg}DXY:{/white-fg}   {bold}${dxy.toFixed(2)}{/bold}   {grey-fg}(as of ${latestDate}, updated ${age}h ago){/grey-fg}`,
    '',
    `  {grey-fg}10-week SMA:{/grey-fg}  ${sma10w.toFixed(2)}`,
    `  {grey-fg}20-week SMA:{/grey-fg}  ${sma20w.toFixed(2)}`,
    '',
    `  Trend:   ${trendTxt}`,
    '',
    `  ${adviceBlock}`,
    '',
    '  {grey-fg}─────────────────────────────────────────────────{/grey-fg}',
    '  {grey-fg}[R] Force refresh   [P] Pause entries   [G] Resume   [Esc/D] Close{/grey-fg}'
  ]
  dxyOverlay.setContent(lines.join('\n'))
}

function toggleDxyOverlay() {
  if (dxyOverlay.hidden) {
    renderDxyOverlay()
    dxyOverlay.show()
    dxyOverlay.focus()
  } else {
    dxyOverlay.hide()
    screen.focusPop()
  }
  screen.render()
}

dxyOverlay.key(['d', 'D'], () => toggleDxyOverlay())
dxyOverlay.key(['r', 'R'], () => {
  if (_client) _client.send({ type: 'force_dxy_refresh' })
  dxyOverlay.setContent('{grey-fg}Fetching DXY from Yahoo Finance...{/grey-fg}')
  screen.render()
})
dxyOverlay.key(['p', 'P'], () => {
  if (_client) _client.send({ type: 'set_trading_paused', paused: true })
})
dxyOverlay.key(['g', 'G'], () => {
  if (_client) _client.send({ type: 'set_trading_paused', paused: false })
})

const OG = '{#ff8c00-fg}'   // orange — replaces grey throughout the overlay
const OGC = '{/#ff8c00-fg}'

function renderNewsOverlay() {
  if (!_newsHistory.length) {
    newsOverlay.setContent(`${OG}No news events yet.${OGC}`)
    return
  }
  const lines = []
  for (const ev of _newsHistory.slice().reverse()) {
    const dirColor  = ev.direction === 'bullish' ? '{green-fg}' : ev.direction === 'bearish' ? '{red-fg}' : OG
    const dirClose  = ev.direction === 'bullish' ? '{/green-fg}' : ev.direction === 'bearish' ? '{/red-fg}' : OGC
    const time      = new Date(ev.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    const date      = new Date(ev.timestamp).toLocaleDateString('en-GB')
    lines.push(
      `${OG}${date} ${time}${OGC}  ` +
      `{white-fg}${(ev.pair || '?').padEnd(10)}{/white-fg}` +
      `${dirColor}${ev.direction}/${ev.confidence}${dirClose}` +
      `  ${OG}src=${ev.source || '?'}${OGC}`
    )
    if (ev.headline) {
      lines.push(`  {white-fg}${ev.headline}{/white-fg}`)
    }
    if (ev.rationale) {
      lines.push(`  ${OG}↳ ${ev.rationale}${OGC}`)
    }
    if (ev.action) {
      const actionColor = ev.direction === 'bullish' ? '{green-fg}' : ev.direction === 'bearish' ? '{red-fg}' : '{white-fg}'
      const actionClose = ev.direction === 'bullish' ? '{/green-fg}' : ev.direction === 'bearish' ? '{/red-fg}' : '{/white-fg}'
      lines.push(`  ${OG}▶ ENGINE:${OGC} ${actionColor}${ev.action}${actionClose}`)
    }
    lines.push(OG + '─'.repeat(70) + OGC)
  }
  newsOverlay.setContent(lines.join('\n'))
  newsOverlay.setScrollPerc(0)
}

function toggleNewsOverlay() {
  if (newsOverlay.hidden) {
    renderNewsOverlay()
    newsOverlay.show()
    newsOverlay.focus()
  } else {
    newsOverlay.hide()
    screen.focusPop()
  }
  screen.render()
}

newsOverlay.key(['escape', 'n', 'N'], () => toggleNewsOverlay())

// ── WebSocket handlers ────────────────────────────────────────────────────────

let _client = null

function buildHandlers() {
  return {
    onConnect() {
      controls.onConnect()
      log.append('{green-fg}● Connected to engine{/green-fg}')
      screen.render()
    },

    onDisconnect(delay) {
      controls.onDisconnect()
      log.append(`{yellow-fg}○ Disconnected — retrying in ${delay / 1000}s{/yellow-fg}`)
      screen.render()
    },

    onDxyUpdate(data) {
      _macroSignal = data.macroSignal
      controls.onDxyUpdate(data.macroSignal)
      if (!dxyOverlay.hidden) renderDxyOverlay()
      screen.render()
    },

    onCandle(data) {
      // data: { type, candleCount, timestamp, signals, agents, agentEvents, adaptCounts }
      if (data.macroSignal) { _macroSignal = data.macroSignal; controls.onDxyUpdate(data.macroSignal) }
      controls.onCandle(data)
      perf.onCandle(data)
      news.tick()

      if (data.signals)     signals.update(data.signals, data.gateTraces || {})
      if (data.agents)      pool.update(data.agents, perf.getBtcReturn())
      if (data.adaptCounts) adaptation.onCounts(data.adaptCounts)

      log.onCandle(data)

      for (const ev of (data.agentEvents || [])) {
        if (ev.type === 'entry')    { log.onEntry(ev) }
        if (ev.type === 'exit')     { log.onExit(ev); perf.onExit(ev) }
        if (ev.type === 'rejected') { log.onRejected(ev) }
      }

      screen.render()
    },

    onTick(data) {
      // data: { type, timestamp, prices, signals }
      controls.onTick()
      if (data.signals) signals.update(data.signals)
      log.onTick(data)
      news.tick()
      screen.render()
    },

    onAdaptResult(data) {
      log.onAdaptResult(data)
      if (data.metaResults?.length) log.onMetaAdaptResult(data.metaResults)
      screen.render()
    },

    onAdaptReset(data) {
      log.onAdaptReset(data)
      screen.render()
    },

    onDxyUpdate(data) {
      _macroSignal = data.macroSignal
      controls.onDxyUpdate(data.macroSignal)
      if (!dxyOverlay.hidden) renderDxyOverlay()
      screen.render()
    }
  }
}

function connect() {
  if (_client) _client.destroy()
  _client = wsClient.connect(HOST, PORT, TOKEN, buildHandlers())
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

screen.key('tab', () => {
  log.nextTab()
  screen.render()
})

screen.key('f', () => {
  if (_client) _client.send({ type: 'force_candle' })
  log.append('{grey-fg}→ force_candle sent{/grey-fg}')
  screen.render()
})

screen.key('a', () => {
  if (_client) _client.send({ type: 'adapt_trigger' })
  log.append('{cyan-fg}→ adapt_trigger sent{/cyan-fg}')
  screen.render()
})

screen.key('r', () => {
  if (_client) _client.send({ type: 'adapt_reset' })
  log.append('{yellow-fg}→ adapt_reset sent{/yellow-fg}')
  screen.render()
})

screen.key('n', () => toggleNewsOverlay())
screen.key('d', () => toggleDxyOverlay())

screen.key(['q', 'Q', 'escape'], () => {
  if (!dxyOverlay.hidden)  { toggleDxyOverlay();  return }
  if (!newsOverlay.hidden) { toggleNewsOverlay(); return }
  if (_client) _client.destroy()
  screen.destroy()
  process.exit(0)
})

screen.key('C-c', () => {
  if (_client) _client.destroy()
  screen.destroy()
  process.exit(0)
})

// ── Adaptation pane — poll REST API for recent config_update events ────────────

const API_BASE = `http://${HOST}:${parseInt(process.env.API_PORT) || 3002}`
let _adaptCursor = 0

async function pollAdaptation() {
  try {
    const url  = `${API_BASE}/events?type=config_update&from_ts=${_adaptCursor}&order=asc&limit=50`
    const res  = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const rows = await res.json()
    for (const ev of rows) {
      adaptation.onConfigUpdate(ev)
      log.onConfigUpdate(ev)
      _adaptCursor = Math.max(_adaptCursor, ev.timestamp + 1)
    }
    if (rows.length) screen.render()
  } catch { /* API not running — silent */ }
}

setInterval(pollAdaptation, 10000)

// ── News log — poll REST API for recent news events ───────────────────────────

let _newsCursor = 0

async function pollNews() {
  try {
    const url  = `${API_BASE}/events?type=news&from_ts=${_newsCursor}&order=asc&limit=50`
    const res  = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const rows = await res.json()
    for (const ev of rows) {
      _newsHistory.push(ev)
      news.onNews(ev)
      log.onNews(ev)
      _newsCursor = Math.max(_newsCursor, ev.timestamp + 1)
    }
    if (rows.length) screen.render()
  } catch { /* API not running — silent */ }
}

setInterval(pollNews, 30000)

// ── Boot ──────────────────────────────────────────────────────────────────────

async function seedFromEngine() {
  try {
    const [perfRes, healthRes] = await Promise.all([
      fetch(`${API_BASE}/performance`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${API_BASE}/health`,      { signal: AbortSignal.timeout(3000) })
    ])
    if (perfRes.ok) {
      const stats = await perfRes.json()
      perf.seed(stats)
      if (stats.n) {
        log.append(`{grey-fg}↺ performance loaded: ${stats.n} trades, cum=${stats.cumPnl >= 0 ? '+' : ''}${stats.cumPnl.toFixed(2)}%{/grey-fg}`)
      }
    }
    if (healthRes.ok) {
      const health = await healthRes.json()
      if (health.uptime) controls.setEngineUptime(health.uptime)
    }
    screen.render()
  } catch { /* API not running yet — silent */ }
}

connect()
screen.render()
log.append(`{grey-fg}Connecting to ${HOST}:${PORT}...{/grey-fg}`)
seedFromEngine()
pollAdaptation()
pollNews()
