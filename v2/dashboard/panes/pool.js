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

  let _agents    = []
  let _btcReturn = null

  box.setContent('{grey-fg}Waiting for engine...{/grey-fg}')

  function colorPct(pct) {
    if (pct == null) return '—'
    const s = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
    return pct >= 0 ? `{green-fg}${s}{/green-fg}` : `{red-fg}${s}{/red-fg}`
  }

  function render() {
    if (!_agents.length) { box.setContent('{grey-fg}Waiting for data...{/grey-fg}'); return }

    const live  = _agents.filter(a => a.mode === 'live')
    const paper = _agents.filter(a => a.mode === 'paper')

    const hdr = `{cyan-fg}{bold}${'ID'.padEnd(4)} ${'Mode'.padEnd(6)} ${'Personality'.padEnd(12)} ${'Total'.padStart(9)} ${'Pos'.padStart(4)} ${'Cfg'.padStart(4)} ${'Unrealised'.padStart(12)}{/bold}{/cyan-fg}`
    const sep  = '{grey-fg}' + '─'.repeat(58) + '{/grey-fg}'
    const lines = [hdr, sep]

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
        lines.push(
          `{grey-fg}  ↳ ${pos.pair.padEnd(10)} ` +
          `$${pos.sizeUsd.toFixed(0).padStart(7)}  ` +
          `entry $${pos.entryPrice.toFixed(0)}  ` +
          `now $${pos.currentPrice.toFixed(0)}  ` +
          `${colorPct(pos.unrealisedPct)}{/grey-fg}`
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
    update(agents, btcReturn = null) {
      _agents    = agents || []
      _btcReturn = btcReturn
      render()
    }
  }
}

module.exports = { create }
