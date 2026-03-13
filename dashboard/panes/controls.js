'use strict'

const VERSION = '1.0.3'

const blessed = require('blessed')

const INTERVALS       = [15000, 30000, 60000, 300000, 900000]
const INTERVAL_LABELS = ['15s', '30s', '1m', '5m', '15m']

function create(parent, clientRef, logPane, screen) {
  const box = blessed.box({
    parent,
    label:  ' CONTROLS ',
    top:    0,
    left:   0,
    width:  '100%',
    height: '100%',
    border: { type: 'line' },
    style:  { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } },
    tags:   true
  })

  const statusBar = blessed.box({
    parent: screen || parent,
    bottom: 0,
    left:   0,
    width:  '70%',
    height: 1,
    style:  { fg: 'white', bg: 'blue' },
    tags:   true
  })

  let connected     = false
  let running       = false
  let round         = 0
  let intervalIdx   = 4   // default 15m
  let nextTickSecs  = 0
  let pendingCmd    = null
  let sellCounts    = { ALPHA: 0, BETA: 0, GAMMA: 0 }
  let sessionTrades = 0
  let megaOnline    = false
  let macroTrend    = 'neutral'
  let proposalReady = false

  const helpText = [
    '{bold}[P]{/bold}         Play / Pause',
    '{bold}[F]{/bold}         Force single tick',
    '{bold}[+][-]{/bold}      Cycle interval: 15s 30s 1m 5m 15m',
    '',
    '{bold}[T][A/B/G/M]{/bold}  Threaten agent',
    '{bold}[U][A/B/G/M]{/bold}  Un-threaten agent',
    '{bold}[X][A/B/G/M]{/bold}  Terminate agent',
    '  then {bold}[E]{/bold}liminate / {bold}[R]{/bold}espawn',
    '',
    '{bold}[O]{/bold}         Toggle MEGA online/offline',
    '{bold}[N]{/bold}         Force session export now',
    '{bold}[S]{/bold}         Toggle signal detail',
    '{bold}[L]{/bold}         Cycle log filter',
    '{bold}[TAB]{/bold}       Cycle agent filter A/B/G/M/All',
    '{bold}[R]{/bold}         Reconnect WebSocket',
    '{bold}[Q]{/bold}         Quit (sim keeps running)',
  ].join('\n')

  box.setContent(helpText)

  // ── Countdown ────────────────────────────────────────────────────────────────
  setInterval(() => {
    if (running && nextTickSecs > 0) nextTickSecs--
    renderStatus()
  }, 1000)

  function renderStatus() {
    const connStr = connected
      ? '{green-fg}● CONNECTED{/green-fg}'
      : '{yellow-fg}○ RECONNECTING...{/yellow-fg}'

    const runStr = running
      ? `{green-fg}▶ RUNNING{/green-fg}  Next: ${nextTickSecs}s`
      : '{yellow-fg}⏸ PAUSED  [P] to start{/yellow-fg}'

    const macroStr = macroTrend === 'bull'
      ? '{green-fg}↑ BULL{/green-fg}'
      : macroTrend === 'bear'
        ? '{red-fg}↓ BEAR{/red-fg}'
        : '{grey-fg}~ NEUTRAL{/grey-fg}'

    let tradesStr = ''
    if (sessionTrades > 0) {
      const a     = sellCounts.ALPHA || 0
      const b     = sellCounts.BETA  || 0
      const g     = sellCounts.GAMMA || 0
      const total = a + b + g
      const done  = total >= sessionTrades
      const totStr = done ? `{green-fg}${total}/${sessionTrades}{/green-fg}` : `${total}/${sessionTrades}`
      tradesStr = `   Sells: A:${a} B:${b} G:${g}  total:${totStr}`
    }

    const proposalStr = proposalReady ? '  {yellow-fg}★ Proposal ready — press [P]{/yellow-fg}' : ''

    statusBar.setContent(
      `  ${connStr}   ${runStr}   Round: ${round}   Interval: ${INTERVAL_LABELS[intervalIdx]}   BTC: ${macroStr}${tradesStr}${proposalStr}`
    )
    parent.screen.render()
  }

  function onTrade(result) {
    if (result && result.sellCounts)    sellCounts    = result.sellCounts
    if (result && result.sessionTrades) sessionTrades = result.sessionTrades
    renderStatus()
  }

  function onConnect() {
    connected = true
    renderStatus()
  }

  function onDisconnect() {
    connected = false
    running   = false
    renderStatus()
  }

  function onTick(snap) {
    round   = snap.round || 0
    running = snap.running || false
    if (snap.intervalMs) {
      const idx = INTERVALS.indexOf(snap.intervalMs)
      if (idx !== -1) intervalIdx = idx
    }
    nextTickSecs = snap.nextTickAt
      ? Math.max(0, Math.round((snap.nextTickAt - Date.now()) / 1000))
      : INTERVALS[intervalIdx] / 1000
    if (snap.sellCounts)           sellCounts    = snap.sellCounts
    if (snap.sessionTrades)        sessionTrades = snap.sessionTrades
    if (snap.realTrading != null)  megaOnline    = snap.realTrading
    if (snap.macroTrend)           macroTrend    = snap.macroTrend
    if (snap.proposalReady != null) proposalReady = snap.proposalReady
    renderStatus()
  }

  function sendCommand(cmd, params) {
    const conn = clientRef && clientRef.current
    if (conn) {
      conn.send({ type: 'COMMAND', command: cmd, ...params })
    } else {
      logPane && logPane.append('{red-fg}Not connected — cannot send command{/red-fg}', 'ERROR')
    }
  }

  function handleKey(screen, ch, key, callbacks) {
    // Pending two-key sequences
    if (pendingCmd === 'T') {
      pendingCmd = null
      const agent = { a: 'ALPHA', b: 'BETA', g: 'GAMMA', m: 'MEGA' }[ch && ch.toLowerCase()]
      if (agent) {
        sendCommand('threaten', { agent })
        logPane && logPane.append(`{yellow-fg}CMD: Threaten ${agent}{/yellow-fg}`, 'SURVIVAL')
      }
      return
    }
    if (pendingCmd === 'U') {
      pendingCmd = null
      const agent = { a: 'ALPHA', b: 'BETA', g: 'GAMMA', m: 'MEGA' }[ch && ch.toLowerCase()]
      if (agent) {
        sendCommand('threaten', { agent, params: { action: 'remove_threat' } })
        logPane && logPane.append(`{green-fg}CMD: Un-threaten ${agent}{/green-fg}`, 'SURVIVAL')
      }
      return
    }
    if (pendingCmd === 'X') {
      pendingCmd = null
      const agent = { a: 'ALPHA', b: 'BETA', g: 'GAMMA', m: 'MEGA' }[ch && ch.toLowerCase()]
      if (agent) pendingCmd = 'X:' + agent
      return
    }
    if (pendingCmd && pendingCmd.startsWith('X:')) {
      const agent = pendingCmd.slice(2)
      pendingCmd  = null
      const sub   = { e: 'eliminate', r: 'respawn', p: 'replace' }[ch && ch.toLowerCase()]
      if (sub) {
        sendCommand('terminate', { agent, params: { action: sub } })
        logPane && logPane.append(`{red-fg}CMD: ${sub} ${agent}{/red-fg}`, 'SURVIVAL')
      }
      return
    }

    switch (ch) {
      case 'p': case 'P':
        if (running) {
          sendCommand('stop')
          running = false
          logPane && logPane.append('{yellow-fg}CMD: Stop{/yellow-fg}', 'TICK')
        } else {
          sendCommand('start')
          running      = true
          nextTickSecs = INTERVALS[intervalIdx] / 1000
          logPane && logPane.append('{green-fg}CMD: Start{/green-fg}', 'TICK')
        }
        renderStatus()
        break

      case 't': case 'T': pendingCmd = 'T'; break
      case 'u': case 'U': pendingCmd = 'U'; break
      case 'x': case 'X': pendingCmd = 'X'; break

      case 'f': case 'F':
        logPane && logPane.append('{cyan-fg}CMD: Force tick → sending...{/cyan-fg}', 'TICK')
        sendCommand('tick')
        break

      case '+':
        intervalIdx = Math.min(intervalIdx + 1, INTERVALS.length - 1)
        sendCommand('set_interval', { params: { ms: INTERVALS[intervalIdx] } })
        renderStatus()
        break
      case '-':
        intervalIdx = Math.max(intervalIdx - 1, 0)
        sendCommand('set_interval', { params: { ms: INTERVALS[intervalIdx] } })
        renderStatus()
        break

      case 'o': case 'O': {
        megaOnline = !megaOnline  // flip locally immediately so double-press works
        sendCommand('set_real_trading', { params: { enabled: megaOnline } })
        callbacks.onRealTradingToggle && callbacks.onRealTradingToggle(megaOnline)
        logPane && logPane.append(
          megaOnline
            ? '{yellow-fg}CMD: MEGA ONLINE — real trading enabled{/yellow-fg}'
            : '{grey-fg}CMD: MEGA OFFLINE — real trading disabled{/grey-fg}',
          'TICK'
        )
        break
      }

      case 'n': case 'N':
        sendCommand('run_pipeline')
        logPane && logPane.append('{cyan-fg}CMD: Force export → running session analysis...{/cyan-fg}', 'TICK')
        break

      case 's': case 'S': callbacks.toggleSignals    && callbacks.toggleSignals();    break
      case 'l': case 'L': callbacks.cycleLog          && callbacks.cycleLog();          break
      case '\t':          callbacks.cycleAgentFilter  && callbacks.cycleAgentFilter();  break

      case 'r': case 'R':
        callbacks.reconnect && callbacks.reconnect()
        logPane && logPane.append('{cyan-fg}Reconnecting...{/cyan-fg}', 'ERROR')
        break

      case 'q': case 'Q':
        screen.destroy()
        process.exit(0)
        break
    }
  }

  renderStatus()

  return { onConnect, onDisconnect, onTick, onTrade, handleKey }
}

module.exports = { create, VERSION }
