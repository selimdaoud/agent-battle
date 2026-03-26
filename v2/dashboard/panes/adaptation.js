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

  const _recentUpdates = []
  const MAX_UPDATES = 12
  let _counts      = {}   // { agentId: { effective, trigger } }
  let _flashActive = false
  let _flashTimer  = null

  function ts(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour12: false })
  }

  function progressBar(value, max, width = 10) {
    const filled = Math.round(Math.min(value, max) / max * width)
    return '█'.repeat(filled) + '░'.repeat(width - filled)
  }

  function render() {
    const lines = []

    // ── Pending exit counters ─────────────────────────────────────────────────
    const agents = Object.keys(_counts)
    if (agents.length) {
      for (const id of agents) {
        const { effective, trigger } = _counts[id]
        const pct  = Math.min(effective / trigger, 1)
        const bar  = progressBar(effective, trigger)
        const color = pct >= 1 ? '{green-fg}' : pct >= 0.6 ? '{yellow-fg}' : '{grey-fg}'
        lines.push(
          `{white-fg}${id.padEnd(3)}{/white-fg} ${color}${bar}{/${color.slice(1, -1)}} ` +
          `{white-fg}${effective.toFixed(1)}{/white-fg}{grey-fg}/${trigger}{/grey-fg}`
        )
      }
      lines.push('{grey-fg}' + '─'.repeat(32) + '{/grey-fg}')
    }

    if (!_recentUpdates.length) {
      lines.push('{grey-fg}No config updates yet.{/grey-fg}')
      box.setContent(lines.join('\n'))
      return
    }

    const hdrStyle = _flashActive
      ? '{black-fg}{yellow-bg} Recent config updates: {/yellow-bg}{/black-fg}'
      : '{cyan-fg}{bold}Recent config updates:{/bold}{/cyan-fg}'
    lines.push(hdrStyle)
    lines.push('{grey-fg}' + '─'.repeat(36) + '{/grey-fg}')

    for (const u of _recentUpdates.slice().reverse().slice(0, MAX_UPDATES)) {
      const dir     = u.newVal > u.oldVal ? '{green-fg}↑{/green-fg}' : '{red-fg}↓{/red-fg}'
      const param   = u.param.split('.').pop().slice(0, 20)
      lines.push(
        `{grey-fg}${ts(u.ts)}{/grey-fg} ${u.agentId.padEnd(3)} ${dir} ` +
        `{white-fg}${param}{/white-fg} ` +
        `{grey-fg}${u.oldVal}→{/grey-fg}{cyan-fg}${u.newVal}{/cyan-fg}`
      )
    }

    box.setContent(lines.join('\n'))
  }

  return {
    onCounts(counts) {
      _counts = counts
      render()
    },
    onConfigUpdate(event) {
      // event: { timestamp, agent_id, param, old_value, new_value }
      _recentUpdates.push({
        ts:      event.timestamp || Date.now(),
        agentId: event.agent_id,
        param:   event.param,
        oldVal:  event.old_value,
        newVal:  event.new_value
      })
      if (_recentUpdates.length > MAX_UPDATES * 2) _recentUpdates.shift()

      // Flash the header for 5 seconds
      _flashActive = true
      if (_flashTimer) clearTimeout(_flashTimer)
      _flashTimer = setTimeout(() => { _flashActive = false; render() }, 5000)

      render()
    },
    clear() { _recentUpdates.length = 0; render() }
  }
}

module.exports = { create }
