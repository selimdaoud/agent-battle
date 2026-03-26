'use strict'

const blessed = require('blessed')

function create(parent, screen) {
  const box = blessed.box({
    parent,
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'grey' } }
  })

  let _connected   = false
  let _candleCount = 0
  let _agentCount  = { live: 0, paper: 0 }
  let _engineStart = null   // derived from engine uptime on connect
  let _lastTickAt  = null
  let _pulseFrame  = 0
  let _macroSignal = null
  let _btcMacroUp  = null   // BTC 4h macro p_trending_up (shared gate for all pairs)

  const PULSE = ['◐', '◓', '◑', '◒']

  function uptime() {
    if (!_engineStart) return '--:--:--'
    const s   = Math.floor((Date.now() - _engineStart) / 1000)
    const h   = Math.floor(s / 3600)
    const m   = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  function lastTickStr() {
    if (!_lastTickAt) return '{grey-fg}no tick yet{/grey-fg}'
    const ago = Math.floor((Date.now() - _lastTickAt) / 1000)
    const stale = ago > 90
    const color = stale ? '{red-fg}' : '{green-fg}'
    return `${color}tick ${ago}s ago{/${color.slice(1, -1)}}`
  }

  function render() {
    const pulse     = _connected && _lastTickAt ? `{cyan-fg}${PULSE[_pulseFrame % 4]}{/cyan-fg}` : '{grey-fg}·{/grey-fg}'
    const connLabel = _connected ? '{green-fg}CONNECTED{/green-fg}' : '{red-fg}DISCONNECTED{/red-fg}'

    const line1 = `${pulse} ${connLabel}  ${lastTickStr()}  {grey-fg}up ${uptime()}{/grey-fg}`
    const line2 = `{grey-fg}candles:{/grey-fg} {white-fg}${_candleCount}{/white-fg}  {grey-fg}agents:{/grey-fg} {cyan-fg}${_agentCount.live}L / ${_agentCount.paper}P{/cyan-fg}`
    const line3 = '{grey-fg}[f] force candle  [a] adapt  [r] reset  [d] DXY  [Q/Esc] quit{/grey-fg}'

    let line4 = ''
    if (_macroSignal && _macroSignal.dxy != null) {
      const { dxy, trend, advice, trading_paused } = _macroSignal
      const trendArrow = trend === 'falling' ? '{green-fg}↓{/green-fg}' : '{red-fg}↑{/red-fg}'
      const dot   = advice === 'green' && !trading_paused ? '{green-fg}⬤{/green-fg}' : '{red-fg}⬤{/red-fg}'
      const label = trading_paused ? '{red-fg}PAUSED{/red-fg}' : advice === 'green' ? '{green-fg}TRADE{/green-fg}' : '{yellow-fg}CAUTION{/yellow-fg}'

      let macroStr = ''
      if (_btcMacroUp !== null) {
        const pct = (_btcMacroUp * 100).toFixed(0) + '%'
        const col = _btcMacroUp >= 0.6 ? '{green-fg}' : _btcMacroUp >= 0.4 ? '{yellow-fg}' : '{red-fg}'
        macroStr = `  {grey-fg}BTC macro↑{/grey-fg} ${col}${pct}{/${col.slice(1,-1)}}`
      }

      line4 = `DXY ${dxy.toFixed(1)} ${trendArrow}  ${dot} ${label}${macroStr}`
    }

    box.setContent([line1, line2, line3, line4].filter(Boolean).join('\n'))
  }

  // Animate pulse + refresh last-tick age every second
  setInterval(() => { _pulseFrame++; render(); screen.render() }, 1000)

  return {
    onConnect() {
      _connected = true
      render()
    },
    setEngineUptime(uptimeSeconds) {
      _engineStart = Date.now() - uptimeSeconds * 1000
      render()
    },
    onDisconnect() {
      _connected  = false
      _lastTickAt = null
      render()
    },
    onTick() {
      _lastTickAt  = Date.now()
      _pulseFrame++
      render()
    },
    onCandle(data) {
      _lastTickAt  = Date.now()
      _candleCount = data.candleCount || _candleCount + 1
      if (data.agents) {
        _agentCount.live  = data.agents.filter(a => a.mode === 'live').length
        _agentCount.paper = data.agents.filter(a => a.mode === 'paper').length
      }
      if (data.macroSignal) _macroSignal = data.macroSignal
      if (data.signals) {
        const btc = data.signals.find(s => s.pair === 'BTCUSDT') || data.signals[0]
        if (btc && btc.macro_p_trending_up != null) _btcMacroUp = btc.macro_p_trending_up
      }
      render()
    },
    onDxyUpdate(macroSignal) {
      _macroSignal = macroSignal
      render()
    }
  }
}

module.exports = { create }
