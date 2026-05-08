'use strict'

const blessed = require('blessed')

const WINDOW = 50   // cumPnl snapshots used for sparkline

function sparkline(series, width = 20) {
  const chars = ' ▁▂▃▄▅▆▇█'
  if (!series.length) return '─'.repeat(width)
  const min   = Math.min(...series)
  const max   = Math.max(...series)
  const range = max - min || 1
  return series.slice(-width).map(v => {
    const idx = Math.round(((v - min) / range) * (chars.length - 1))
    return chars[Math.max(0, Math.min(chars.length - 1, idx))]
  }).join('')
}

function create(parent) {
  const box = blessed.box({
    parent,
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true
  })

  let _pnlHistory        = []
  let _cumPnlLog         = []
  let _btcEntry          = null
  let _btcCurrent        = null
  let _portfolioValue    = null   // current total value across live agents
  let _portfolioBaseline = null   // value at first candle of this TUI session
  let _agentValues       = []     // [{ id, totalValue }] for live agents

  function render() {
    const h      = _pnlHistory
    const n      = h.length
    const wins   = h.filter(p => p > 0)
    const losses = h.filter(p => p <= 0)

    const cumPnl  = n ? h.reduce((s, p) => s + p, 0) : 0
    const avg     = n ? cumPnl / n : 0
    const winRate = n ? (wins.length / n) * 100 : 0
    const avgWin  = wins.length   ? wins.reduce((s, p)   => s + p, 0)           / wins.length   : 0
    const avgLoss = losses.length ? losses.reduce((s, p) => s + Math.abs(p), 0) / losses.length : 0
    const btcRet  = _btcEntry && _btcCurrent ? ((_btcCurrent - _btcEntry) / _btcEntry) * 100 : null

    const spark      = sparkline(_cumPnlLog.slice(-WINDOW), 30)
    const sparkColor = cumPnl >= 0 ? '{green-fg}' : '{red-fg}'

    // Portfolio value line
    let portfolioLine = '{grey-fg}Portfolio: —{/grey-fg}'
    if (_portfolioValue != null) {
      const fmt      = v => '$' + v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      const delta    = _portfolioBaseline != null ? _portfolioValue - _portfolioBaseline : null
      const deltaPct = _portfolioBaseline ? (delta / _portfolioBaseline) * 100 : null
      const sign     = delta != null && delta >= 0 ? '+' : ''
      const valColor = delta == null || delta >= 0 ? '{green-fg}' : '{red-fg}'
      const agentStr = _agentValues.map(a => `{grey-fg}${a.id}:{/grey-fg}${fmt(a.totalValue)}`).join('  ')
      portfolioLine =
        `{cyan-fg}Portfolio:{/cyan-fg} ${valColor}{bold}${fmt(_portfolioValue)}{/bold}` +
        (delta != null ? `  ${sign}${fmt(delta)} (${sign}${deltaPct.toFixed(2)}%){/${valColor.slice(1, -1)}}` : `{/${valColor.slice(1, -1)}}`) +
        `  ${agentStr}`
    }

    const noTrades = !n ? '{grey-fg}No trades yet{/grey-fg}  ' : ''

    const lines = [
      portfolioLine,

      `${sparkColor}${spark}{/${sparkColor.slice(1, -1)}}  ` +
      `{cyan-fg}Cum:{/cyan-fg} ${cumPnl >= 0 ? `{green-fg}+${cumPnl.toFixed(2)}%{/green-fg}` : `{red-fg}${cumPnl.toFixed(2)}%{/red-fg}`}` +
      (btcRet != null ? `  {grey-fg}BTC: ${btcRet >= 0 ? '+' : ''}${btcRet.toFixed(2)}%{/grey-fg}` : ''),

      `${noTrades}{cyan-fg}AvgP&L:{/cyan-fg} ${avg >= 0 ? `{green-fg}+${avg.toFixed(3)}%{/green-fg}` : `{red-fg}${avg.toFixed(3)}%{/red-fg}`}  ` +
      `{cyan-fg}WinRate:{/cyan-fg} {white-fg}${winRate.toFixed(1)}%{/white-fg}  ` +
      `{cyan-fg}N:{/cyan-fg} ${n}`,

      `{cyan-fg}AvgW:{/cyan-fg} {green-fg}+${avgWin.toFixed(2)}%{/green-fg}  ` +
      `{cyan-fg}AvgL:{/cyan-fg} {red-fg}-${avgLoss.toFixed(2)}%{/red-fg}  ` +
      `{cyan-fg}Ratio:{/cyan-fg} ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '—'}`
    ]

    box.setContent(lines.join('\n'))
  }

  render()

  return {
    // Called once on TUI startup with data from GET /performance
    seed(stats) {
      _pnlHistory = stats.pnlHistory || []
      _cumPnlLog  = stats.cumPnlLog  || []
      render()
    },

    onCandle(data) {
      const btcPrice = data.signals?.find(s => s.pair === 'BTCUSDT')?.price
      if (btcPrice) {
        if (_btcEntry == null) _btcEntry = btcPrice
        _btcCurrent = btcPrice
      }

      if (data.agents) {
        const live = data.agents.filter(a => a.mode === 'live')
        _agentValues    = live.map(a => ({ id: a.id, totalValue: a.totalValue }))
        _portfolioValue = live.reduce((s, a) => s + a.totalValue, 0)
        if (_portfolioBaseline == null && _portfolioValue > 0) _portfolioBaseline = _portfolioValue
      }

      render()
    },

    onExit(action) {
      if (action.mode !== 'live') return
      _pnlHistory.push(action.pnl_pct || 0)
      if (_pnlHistory.length > 200) _pnlHistory.shift()
      const cum = _pnlHistory.reduce((s, p) => s + p, 0)
      _cumPnlLog.push(cum)
      if (_cumPnlLog.length > WINDOW * 2) _cumPnlLog.shift()
      render()
    },

    getBtcReturn() {
      return _btcEntry && _btcCurrent ? ((_btcCurrent - _btcEntry) / _btcEntry) * 100 : null
    }
  }
}

module.exports = { create }
