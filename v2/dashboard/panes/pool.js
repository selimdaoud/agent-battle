'use strict'

const blessed = require('blessed')

function create(parent) {
  const box = blessed.box({
    parent,
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    style: { scrollbar: { bg: 'cyan' } }
  })

  let _agents      = []
  let _btcReturn   = null
  let _macroUp     = null   // macro_p_trending_up from latest BTC signal
  let _marketCtx   = null   // { vix, spxDayPct, ok, error, fetchedAt }
  let _macroSignal = null   // { dxy, trend, advice, trading_paused, ... }

  box.setContent('{grey-fg}Waiting for engine...{/grey-fg}')

  function colorPct(pct) {
    if (pct == null) return '—'
    const s = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
    return pct >= 0 ? `{green-fg}${s}{/green-fg}` : `{red-fg}${s}{/red-fg}`
  }

  function fmtPx(px) {
    if (!px) return '0'
    return px >= 1000 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toFixed(5)
  }

  function marketContextLine() {
    const ctx = _marketCtx
    if (!ctx) return null

    // Status dot
    let statusStr
    if (ctx.ok === null) {
      statusStr = '{grey-fg}● …{/grey-fg}'
    } else if (!ctx.ok) {
      statusStr = `{red-fg}✗ ${(ctx.error || 'err').slice(0, 24)}{/red-fg}`
    } else {
      const ageMin   = ctx.fetchedAt ? Math.floor((Date.now() - ctx.fetchedAt) / 60000) : 99
      const dotColor = ageMin < 15 ? 'green' : 'yellow'
      const timeStr  = new Date(ctx.fetchedAt).toISOString().slice(11, 16) + 'z'
      statusStr = `{${dotColor}-fg}●{/${dotColor}-fg} {grey-fg}${timeStr}{/grey-fg}`
    }

    // VIX
    let vixStr
    if (ctx.vix == null) {
      vixStr = '{grey-fg}VIX —{/grey-fg}'
    } else {
      const v = ctx.vix
      const [label, color] =
        v < 15 ? ['CALM    ', 'green']  :
        v < 20 ? ['NORMAL  ', 'white']  :
        v < 25 ? ['ELEVATED', 'yellow'] :
        v < 30 ? ['HIGH    ', 'yellow'] :
                 ['PANIC   ', 'red']
      vixStr = `{cyan-fg}VIX{/cyan-fg} {${color}-fg}{bold}${v.toFixed(2)}{/bold}  ${label}{/${color}-fg}`
    }

    // SPX
    let spxStr
    if (ctx.spxDayPct == null) {
      spxStr = '{grey-fg}SPX —{/grey-fg}'
    } else {
      const pct   = ctx.spxDayPct
      const sign  = pct >= 0 ? '+' : ''
      const color = pct >= 0 ? 'green' : 'red'
      spxStr = `{cyan-fg}SPX{/cyan-fg} {${color}-fg}${sign}${pct.toFixed(2)}%{/${color}-fg}`
    }

    // Combined signal
    let signalStr = ''
    const v = ctx.vix, p = ctx.spxDayPct
    if (v != null && p != null) {
      const [label, color] =
        v >= 30 && p < -1  ? ['STAY OUT      ', 'red']    :
        v >= 25 && p <  0  ? ['RISK OFF      ', 'red']    :
        v >= 20 && p <  0  ? ['CAUTION       ', 'yellow'] :
        v <  20 && p < -1  ? ['CAUTION       ', 'yellow'] :
        v <  20 && p >= 0  ? ['GREEN LIGHT   ', 'green']  :
                             ['NEUTRAL       ', 'grey']
      signalStr = `  {grey-fg}│{/grey-fg}  {${color}-fg}{bold}${label}{/bold}{/${color}-fg}`
    }

    // DXY
    let dxyStr = ''
    if (_macroSignal && _macroSignal.dxy != null) {
      const { dxy, trend, advice, trading_paused } = _macroSignal
      const arrow = trend === 'falling' ? '{green-fg}↓{/green-fg}' : '{red-fg}↑{/red-fg}'
      const [advLabel, advColor] = trading_paused   ? ['PAUSED ', 'red']    :
                                   advice === 'green' ? ['TRADE  ', 'green']  :
                                                        ['CAUTION', 'yellow']
      dxyStr = `{cyan-fg}DXY{/cyan-fg} {white-fg}{bold}${dxy.toFixed(1)}{/bold}{/white-fg} ${arrow} {${advColor}-fg}${advLabel}{/${advColor}-fg}    `
    }

    return `${dxyStr}${vixStr}    ${spxStr}    ${statusStr}${signalStr}`
  }

  function macroStatusLine() {
    if (_macroUp == null) return '{grey-fg}MACRO 4h: —{/grey-fg}'
    const val = _macroUp
    let label, color
    if (val >= 0.80)      { label = 'STRONG TREND ▲'; color = '{green-fg}' }
    else if (val >= 0.50) { label = 'WEAK TREND ▲';   color = '{yellow-fg}' }
    else if (val >= 0.20) { label = 'TRANSITION';      color = '{yellow-fg}' }
    else                  { label = 'RANGING ▬';       color = '{red-fg}' }
    const close = `{/${color.slice(1, -1)}}`
    // show per-agent gate status (▲ open / ✗ blocked)
    const thresholds = { A1: 0.70, A2: 0.75, A3: null, A4: 0.65, A5: 0.60, A6: 0.70 }
    const gates = _agents.map(a => {
      const thr = thresholds[a.id]
      if (thr == null) return `{grey-fg}${a.id}:—{/grey-fg}`
      return val >= thr
        ? `{green-fg}${a.id}:▲{/green-fg}`
        : `{red-fg}${a.id}:✗{/red-fg}`
    }).join(' ')
    return `{cyan-fg}MACRO 4h:{/cyan-fg} ${color}{bold}${val.toFixed(4)}{/bold}  ${label}${close}  ${gates}`
  }

  function render() {
    if (!_agents.length) { box.setContent('{grey-fg}Waiting for data...{/grey-fg}'); return }

    const live  = _agents.filter(a => a.mode === 'live')
    const paper = _agents.filter(a => a.mode === 'paper')

    const hdr = `{cyan-fg}{bold}${'ID'.padEnd(4)} ${'Mode'.padEnd(6)} ${'Personality'.padEnd(12)} ${'Total'.padStart(9)} ${'Pos'.padStart(4)} ${'Cfg'.padStart(4)} ${'Unrealised'.padStart(12)}{/bold}{/cyan-fg}`
    const sep  = '{grey-fg}' + '─'.repeat(58) + '{/grey-fg}'
    const mktLine = marketContextLine()
    const lines = [macroStatusLine()]
    if (mktLine) lines.push(mktLine)
    lines.push(sep, hdr, sep)

    for (const a of [...live, ...paper]) {
      const unrealised = a.positions.reduce((s, p) => s + (p.unrealisedPct || 0), 0)
      const modeTag    = a.mode === 'live' ? '{cyan-fg}live  {/cyan-fg}' : '{grey-fg}paper {/grey-fg}'
      const persona    = (a.personality || '—').padEnd(12)

      lines.push(
        `{bold}${a.id.padEnd(4)}{/bold} ${modeTag}` +
        `{white-fg}${persona}{/white-fg}` +
        ` $${a.totalValue.toFixed(0).padStart(8)}` +
        ` ${String(a.positionCount).padStart(4)}` +
        ` v${String(a.configVersion).padStart(3)}` +
        `  ${colorPct(unrealised)}`
      )

      for (const pos of a.positions) {
        const lock = pos.blocked ? ' {yellow-fg}🔒{/yellow-fg}' : ''
        lines.push(
          `{grey-fg}  ↳ ${pos.pair.padEnd(10)} ` +
          `$${pos.sizeUsd.toFixed(0).padStart(7)}  ` +
          `entry $${fmtPx(pos.entryPrice)}  ` +
          `now $${fmtPx(pos.currentPrice)}  ` +
          `${colorPct(pos.unrealisedPct)}{/grey-fg}${lock}`
        )
      }
    }

    lines.push(sep)
    const btcLine = _btcReturn != null
      ? `{grey-fg}BTC hold: ${colorPct(_btcReturn)}{/grey-fg}`
      : '{grey-fg}BTC benchmark: —{/grey-fg}'
    lines.push(btcLine)

    box.setContent(lines.join('\n'))
  }

  return {
    update(agents, btcReturn = null, macroUp = null, marketCtx = null, macroSignal = null) {
      _agents    = agents || []
      _btcReturn = btcReturn
      if (macroUp     != null) _macroUp      = macroUp
      if (marketCtx   != null) _marketCtx    = marketCtx
      if (macroSignal != null) _macroSignal  = macroSignal
      render()
    }
  }
}

module.exports = { create }
