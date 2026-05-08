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

const marketContext = require('./market-context')

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

// ── Macro history overlay ─────────────────────────────────────────────────────

const MACRO_THRESHOLDS = [
  { val: 0.75, label: 'A2',    color: 'magenta' },
  { val: 0.70, label: 'A1/A6', color: 'yellow'  },
  { val: 0.65, label: 'A4',    color: 'cyan'     },
  { val: 0.60, label: 'A5',    color: 'white'    },
]
const CHART_H = 14

let _macroHours = 12
let _macroTicks = null

const macroHistBox = blessed.box({
  parent: screen,
  top: '3%', left: '3%',
  width: '94%', height: '94%',
  label: ' MACRO HISTORY  [1] 12h  [2] 24h  [3] 36h  ·  [H/Esc] close ',
  tags: true, hidden: true,
  scrollable: true, alwaysScroll: true,
  keys: true, mouse: true,
  border: { type: 'line' },
  style: {
    bg: 'black', fg: 'white',
    border: { fg: 'green', bg: 'black' },
    label:  { fg: 'green', bg: 'black', bold: true },
    scrollbar: { bg: 'green' }
  }
})

function sampleArray(arr, maxLen) {
  if (arr.length <= maxLen) return arr
  const step = arr.length / maxLen
  return Array.from({ length: maxLen }, (_, i) => arr[Math.min(arr.length - 1, Math.round(i * step))])
}

function renderMacroHistContent() {
  if (!_macroTicks) { macroHistBox.setContent('{grey-fg}Loading...{/grey-fg}'); return }
  if (!_macroTicks.length) { macroHistBox.setContent('{grey-fg}No tick data for this window.{/grey-fg}'); return }

  const ticks  = _macroTicks
  const lines  = []
  const chartW = Math.max(20, Math.min(ticks.length, 78))
  const sampled = sampleArray(ticks, chartW)

  const first = new Date(ticks[0].timestamp).toISOString().slice(0, 16).replace('T', ' ')
  const last  = new Date(ticks[ticks.length - 1].timestamp).toISOString().slice(0, 16).replace('T', ' ')
  lines.push(`{grey-fg}  ${first}  →  ${last}   (${ticks.length} candles, window=${_macroHours}h){/grey-fg}`)
  lines.push('')

  // ── Chart ─────────────────────────────────────────────────────────────────
  for (let row = 0; row <= CHART_H; row++) {
    const rowVal = 1 - (row / CHART_H)
    const yLabel = rowVal.toFixed(2).padStart(4)

    // nearest threshold at this row height
    const thr = MACRO_THRESHOLDS.find(t => Math.abs((1 - t.val) * CHART_H - row) < 0.5)

    let cells = ''
    for (const tick of sampled) {
      const macroVal = tick.macro_p_trending_up ?? tick.p_trending_up
      const fillRow = (1 - macroVal) * CHART_H
      if (row >= fillRow) {
        const v = macroVal
        const c = v >= 0.70 ? 'green' : v >= 0.40 ? 'yellow' : 'red'
        cells += `{${c}-fg}█{/${c}-fg}`
      } else if (thr) {
        cells += `{${thr.color}-fg}╌{/${thr.color}-fg}`
      } else {
        cells += ' '
      }
    }

    const thrLabel = thr ? `  {${thr.color}-fg}← ${thr.label} (≥${thr.val}){/${thr.color}-fg}` : ''
    lines.push(`{grey-fg}${yLabel}│{/grey-fg}${cells}${thrLabel}`)
  }

  // Time axis
  lines.push('{grey-fg}    └' + '─'.repeat(chartW) + '{/grey-fg}')
  const pts  = [0, 0.25, 0.5, 0.75, 1].map(f => Math.min(sampled.length - 1, Math.round(f * (sampled.length - 1))))
  let tAxis  = '     '
  let prevEnd = 0
  for (const pos of pts) {
    const lbl = new Date(sampled[pos].timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
    const pad = Math.max(0, pos - prevEnd)
    tAxis  += ' '.repeat(pad) + lbl
    prevEnd = pos + lbl.length
  }
  lines.push(`{grey-fg}${tAxis}{/grey-fg}`)
  lines.push('')

  // ── BTC price sparkline ───────────────────────────────────────────────────
  const prices = sampled.map(t => t.mid).filter(Boolean)
  if (prices.length) {
    const spark = (() => {
      const chars = ' ▁▂▃▄▅▆▇█'
      const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1
      return prices.map(p => chars[Math.round(((p - min) / range) * (chars.length - 1))]).join('')
    })()
    const pMin = Math.min(...prices), pMax = Math.max(...prices)
    lines.push(`{grey-fg} BTC│{/grey-fg}{cyan-fg}${spark}{/cyan-fg}  {grey-fg}$${pMin.toFixed(0)}–$${pMax.toFixed(0)}{/grey-fg}`)
    lines.push('')
  }

  // ── Hourly table ──────────────────────────────────────────────────────────
  lines.push('{cyan-fg}{bold}  Time (UTC)      Macro 4h   Regime           BTC{/bold}{/cyan-fg}')
  lines.push('{grey-fg}  ' + '─'.repeat(52) + '{/grey-fg}')
  const step = Math.max(1, Math.floor(ticks.length / 18))
  for (let i = 0; i < ticks.length; i += step) {
    const t = ticks[i]
    const time = new Date(t.timestamp).toISOString().slice(11, 16)
    const v    = t.macro_p_trending_up ?? t.p_trending_up
    const regime = v >= 0.70 ? '{green-fg}TREND  ▲{/green-fg}' :
                   v >= 0.40 ? '{yellow-fg}WEAK   ▲{/yellow-fg}' :
                                '{red-fg}RANGING ▬{/red-fg}'
    const px = t.mid ? `$${t.mid.toFixed(0)}` : '—'
    lines.push(`{grey-fg}  ${time}           {/grey-fg}{white-fg}${v.toFixed(4)}{/white-fg}     ${regime}       {grey-fg}${px}{/grey-fg}`)
  }

  lines.push('')
  lines.push('{grey-fg}  [1] 12h  [2] 24h  [3] 36h  ·  [H/Esc] close{/grey-fg}')
  macroHistBox.setContent(lines.join('\n'))
  macroHistBox.setScrollPerc(0)
}

async function fetchAndRenderMacroHist() {
  _macroTicks = null
  macroHistBox.setContent(`{grey-fg}Loading last ${_macroHours}h of macro data...{/grey-fg}`)
  screen.render()
  try {
    const from_ts = Date.now() - _macroHours * 3600 * 1000
    const url     = `${API_BASE}/events?type=tick&pair=BTCUSDT&from_ts=${from_ts}&order=asc&limit=500`
    const res     = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    _macroTicks = await res.json()
    renderMacroHistContent()
  } catch (err) {
    macroHistBox.setContent(`{red-fg}Error loading macro history: ${err.message}{/red-fg}`)
  }
  screen.render()
}

function toggleMacroHistOverlay() {
  if (macroHistBox.hidden) {
    macroHistBox.show()
    macroHistBox.focus()
    fetchAndRenderMacroHist()
  } else {
    macroHistBox.hide()
    screen.focusPop()
  }
  screen.render()
}

macroHistBox.key(['h', 'H'],  () => toggleMacroHistOverlay())
macroHistBox.key(['1'], () => { _macroHours = 12; fetchAndRenderMacroHist() })
macroHistBox.key(['2'], () => { _macroHours = 24; fetchAndRenderMacroHist() })
macroHistBox.key(['3'], () => { _macroHours = 36; fetchAndRenderMacroHist() })

// ── WebSocket handlers ────────────────────────────────────────────────────────

let _client     = null
let _agentsData = []   // dernière snapshot des agents, mise à jour à chaque candle/buy/sell

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
      pool.update(_agentsData || [], perf.getBtcReturn(), null, marketContext.get(), _macroSignal)
      screen.render()
    },

    onCandle(data) {
      // data: { type, candleCount, timestamp, signals, agents, agentEvents, adaptCounts }
      if (data.macroSignal) { _macroSignal = data.macroSignal; controls.onDxyUpdate(data.macroSignal) }
      controls.onCandle(data)
      perf.onCandle(data)
      news.tick()

      if (data.signals)     signals.update(data.signals, data.gateTraces || {})
      if (data.agents) {
        const macroUp = data.signals?.find(s => s.pair === 'BTCUSDT')?.macro_p_trending_up ?? null
        _agentsData = data.agents
        marketContext.refresh().catch(() => {})
        pool.update(data.agents, perf.getBtcReturn(), macroUp, marketContext.get(), _macroSignal)
      }
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
      pool.update(_agentsData || [], perf.getBtcReturn(), null, marketContext.get(), _macroSignal)
      screen.render()
    },

    onManualBuyResult(data) {
      if (data.ok) {
        log.append(`{green-fg}✓ A3 acheté ${data.pair}  @${data.price.toFixed(2)}  $${data.size_usd.toFixed(0)}{/green-fg}`)
        if (data.agents) { _agentsData = data.agents; pool.update(data.agents, perf.getBtcReturn(), null, marketContext.get(), _macroSignal) }
      } else {
        log.append(`{red-fg}✗ manual_buy échoué: ${data.error}{/red-fg}`)
      }
      screen.render()
    },

    onManualToggleBlockResult(data) {
      if (data.ok) {
        const state = data.blocked ? '{yellow-fg}🔒 bloquée{/yellow-fg}' : '{grey-fg}débloquée{/grey-fg}'
        log.append(`${state}  A3 ${data.pair}`)
        if (data.agents) { _agentsData = data.agents; pool.update(data.agents, perf.getBtcReturn(), null, marketContext.get(), _macroSignal) }
      } else {
        log.append(`{red-fg}✗ toggle block échoué: ${data.error}{/red-fg}`)
      }
      screen.render()
    },

    onManualSellResult(data) {
      if (data.ok) {
        const sign = data.pnl_pct >= 0 ? '+' : ''
        log.append(`{green-fg}✓ A3 vendu ${data.pair}  @${data.price.toFixed(2)}  ${sign}${data.pnl_pct.toFixed(2)}%{/green-fg}`)
        if (data.agents) { _agentsData = data.agents; pool.update(data.agents, perf.getBtcReturn(), null, marketContext.get(), _macroSignal) }
      } else {
        log.append(`{red-fg}✗ manual_sell échoué: ${data.error}{/red-fg}`)
      }
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
screen.key('h', () => toggleMacroHistOverlay())

function openManualBuyPrompt() {
  const prompt = blessed.prompt({
    parent: screen,
    top: 'center', left: 'center',
    width: '40%', height: 'shrink',
    label: ' {green-fg}ACHAT — A3 / BTCUSDT{/green-fg} ',
    tags: true,
    border: { type: 'line' },
    style: { bg: 'black', fg: 'white', border: { fg: 'green', bg: 'black' } }
  })
  prompt.input('Montant USD :', '', (err, value) => {
    prompt.destroy()
    screen.render()
    if (err || value == null) return
    const amountUsd = parseFloat(value)
    if (isNaN(amountUsd) || amountUsd <= 0) {
      log.append('{red-fg}✗ montant invalide{/red-fg}')
      screen.render()
      return
    }
    if (_client) _client.send({ type: 'manual_buy', agent_id: 'A3', pair: 'BTCUSDT', amountUsd })
    log.append(`{yellow-fg}→ manual_buy A3 BTCUSDT $${amountUsd.toFixed(0)} envoyé{/yellow-fg}`)
    screen.render()
  })
}

function openManualSellMenu() {
  const a3        = _agentsData.find(a => a.id === 'A3')
  const positions = a3 ? a3.positions : []

  if (!positions.length) {
    log.append('{yellow-fg}A3 n\'a pas de position ouverte{/yellow-fg}')
    screen.render()
    return
  }

  const items = [
    ...positions.map(p => {
      const sign = p.unrealisedPct >= 0 ? '+' : ''
      return `  ${p.pair.padEnd(10)} $${p.sizeUsd.toFixed(0).padStart(7)}  ${sign}${p.unrealisedPct.toFixed(2)}%`
    }),
    '  ─ Annuler'
  ]

  const list = blessed.list({
    parent: screen,
    top: 'center', left: 'center',
    width: 46, height: items.length + 4,
    label: ' {red-fg}VENTE MANUELLE — A3{/red-fg} ',
    tags: true,
    border: { type: 'line' },
    keys: true, vi: true,
    style: {
      bg: 'black', fg: 'white',
      border: { fg: 'red', bg: 'black' },
      selected: { bg: 'red', fg: 'white', bold: true }
    },
    items
  })
  list.focus()
  screen.render()

  list.on('select', (_item, index) => {
    list.destroy()
    screen.render()
    if (index >= positions.length) return   // Annuler
    const { posId, pair } = positions[index]
    if (_client) _client.send({ type: 'manual_sell', agent_id: 'A3', posId })
    log.append(`{yellow-fg}→ manual_sell A3 ${pair} envoyé{/yellow-fg}`)
    screen.render()
  })

  list.key(['escape', 'q'], () => { list.destroy(); screen.render() })
}

function openBlockMenu() {
  const a3        = _agentsData.find(a => a.id === 'A3')
  const positions = a3 ? a3.positions : []

  if (!positions.length) {
    log.append('{yellow-fg}A3 n\'a pas de position ouverte{/yellow-fg}')
    screen.render()
    return
  }

  const items = [
    ...positions.map(p => {
      const lock = p.blocked ? '{yellow-fg}[LOCK]{/yellow-fg} ' : '{grey-fg}[    ]{/grey-fg} '
      const sign = p.unrealisedPct >= 0 ? '+' : ''
      return `  ${lock}${p.pair.padEnd(10)} $${p.sizeUsd.toFixed(0).padStart(7)}  ${sign}${p.unrealisedPct.toFixed(2)}%`
    }),
    '  ─ Annuler'
  ]

  const list = blessed.list({
    parent: screen,
    top: 'center', left: 'center',
    width: 52, height: items.length + 4,
    label: ' {yellow-fg}BLOQUER / DÉBLOQUER — A3{/yellow-fg} ',
    tags: true,
    border: { type: 'line' },
    keys: true, vi: true,
    style: {
      bg: 'black', fg: 'white',
      border: { fg: 'yellow', bg: 'black' },
      selected: { bg: 'yellow', fg: 'black', bold: true }
    },
    items
  })
  list.focus()
  screen.render()

  list.on('select', (_item, index) => {
    list.destroy()
    screen.render()
    if (index >= positions.length) return   // Annuler
    const { posId } = positions[index]
    if (_client) _client.send({ type: 'manual_toggle_block', agent_id: 'A3', posId })
    screen.render()
  })

  list.key(['escape', 'q'], () => { list.destroy(); screen.render() })
}

function openManualMenu() {
  const list = blessed.list({
    parent: screen,
    top: 'center', left: 'center',
    width: 36, height: 8,
    label: ' {cyan-fg}A3 — Action manuelle{/cyan-fg} ',
    tags: true,
    border: { type: 'line' },
    keys: true, vi: true,
    style: {
      bg: 'black', fg: 'white',
      border: { fg: 'cyan', bg: 'black' },
      selected: { bg: 'cyan', fg: 'black', bold: true }
    },
    items: ['  Acheter du BTC', '  Vendre une position', '  Bloquer / Débloquer', '  Annuler']
  })
  list.focus()
  screen.render()

  list.on('select', (_item, index) => {
    list.destroy()
    screen.render()
    if (index === 0) openManualBuyPrompt()
    else if (index === 1) openManualSellMenu()
    else if (index === 2) openBlockMenu()
  })

  list.key(['escape', 'q'], () => { list.destroy(); screen.render() })
}

screen.key('b', () => openManualMenu())

screen.key(['q', 'Q', 'escape'], () => {
  if (!dxyOverlay.hidden)      { toggleDxyOverlay();        return }
  if (!newsOverlay.hidden)     { toggleNewsOverlay();       return }
  if (!macroHistBox.hidden)    { toggleMacroHistOverlay();  return }
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

marketContext.refresh().catch(() => {})
connect()
screen.render()
log.append(`{grey-fg}Connecting to ${HOST}:${PORT}...{/grey-fg}`)
seedFromEngine()
pollAdaptation()
pollNews()
