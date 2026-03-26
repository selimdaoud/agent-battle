'use strict'

const blessed = require('blessed')

const MAX_LINES = 200

// Tab order: All, A1-A6 trades, Adaptation, News
const TABS = ['All', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Adapt', 'News']

function create(parent) {
  const box = blessed.box({
    parent,
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'grey' },
      label:  { fg: 'grey' },
      scrollbar: { bg: 'grey' }
    }
  })

  // One buffer per tab
  const _buffers = {}
  for (const t of TABS) _buffers[t] = []

  let _activeTab  = 'All'
  let _tickCount  = 0

  function ts(ms) {
    return new Date(ms || Date.now()).toLocaleTimeString('en-GB', { hour12: false })
  }

  function tabBar() {
    return TABS.map(t =>
      t === _activeTab
        ? `{cyan-fg}{bold}[${t}]{/bold}{/cyan-fg}`
        : `{grey-fg}${t}{/grey-fg}`
    ).join('  ')
  }

  function render() {
    const lines = [tabBar(), '{grey-fg}' + '─'.repeat(50) + '{/grey-fg}', ..._buffers[_activeTab]]
    box.setContent(lines.join('\n'))
    box.setScrollPerc(100)
  }

  // Push a line to specified tabs
  function push(line, tabs) {
    for (const t of tabs) {
      const buf = _buffers[t]
      buf.push(line)
      if (buf.length > MAX_LINES) buf.shift()
    }
    render()
  }

  // Push to All + a specific agent tab
  function pushAgent(agentId, line) {
    push(line, ['All', agentId])
  }

  // Push to Adapt tab only
  function pushAdapt(line) {
    push(line, ['Adapt'])
  }

  return {
    nextTab() {
      const idx = TABS.indexOf(_activeTab)
      _activeTab = TABS[(idx + 1) % TABS.length]
      render()
    },

    onTick(data) {
      _tickCount++
      const pairs  = data.signals?.length || 0
      const btc    = data.signals?.find(s => s.pair === 'BTCUSDT')
      const btcStr = btc ? `  BTC $${btc.price.toFixed(0)}` : ''
      push(`{grey-fg}${ts(data.timestamp)} tick #${_tickCount}${btcStr}  (${pairs} pairs){/grey-fg}`, ['All'])
    },

    onCandle(data) {
      push(
        `{cyan-fg}${ts(data.timestamp)} ── candle #${data.candleCount}  ${data.signals?.length || 0} pairs ──{/cyan-fg}`,
        ['All']
      )
    },

    onEntry(action) {
      const color = action.mode === 'live' ? '{green-fg}' : '{grey-fg}'
      const line  =
        `${ts(action.timestamp)} ${color}{bold}${action.agent_id.padEnd(3)}{/bold} ENTRY  ` +
        `${action.pair}  $${(action.size_usd || 0).toFixed(0)}  ` +
        `score=${(action.entry_score || 0).toFixed(3)}  ` +
        `cfg=v${action.config_version}{/${color.slice(1, -1)}}`
      pushAgent(action.agent_id, line)
    },

    onExit(action) {
      const pnl   = action.pnl_pct || 0
      const color = pnl >= 0 ? '{yellow-fg}' : '{red-fg}'
      const sign  = pnl >= 0 ? '+' : ''
      const line  =
        `${ts(action.timestamp)} ${color}{bold}${action.agent_id.padEnd(3)}{/bold} EXIT   ` +
        `${action.pair}  ${sign}${pnl.toFixed(2)}%  ` +
        `reason=${action.exit_reason}  held=${action.holding_rounds}r  ` +
        `cfg=v${action.config_version}{/${color.slice(1, -1)}}`
      pushAgent(action.agent_id, line)
    },

    onRejected(action) {
      const line =
        `{grey-fg}${ts(action.timestamp)} ${action.agent_id.padEnd(3)} REJECT ` +
        `${action.pair}  gate=${action.gate_failed}  score=${(action.signal_score || 0).toFixed(3)}{/grey-fg}`
      pushAgent(action.agent_id, line)
    },

    onConfigUpdate(event) {
      const dir    = event.new_value > event.old_value ? '{green-fg}↑{/green-fg}' : '{red-fg}↓{/red-fg}'
      const source = event.triggered_by === 'meta-adapt'        ? '{magenta-fg}META  {/magenta-fg}'
                   : event.triggered_by === 'adaptation-engine' ? '{cyan-fg}ADAPT {/cyan-fg}'
                   :                                              '{grey-fg}MANUAL{/grey-fg}'
      const line =
        `{grey-fg}${ts(event.timestamp)}{/grey-fg} ${event.agent_id.padEnd(3)} ${source} ${dir} ` +
        `{white-fg}${event.param.split('.').pop().padEnd(24)}{/white-fg} ` +
        `{grey-fg}${event.old_value} → {/grey-fg}{cyan-fg}${event.new_value}{/cyan-fg}` +
        `{grey-fg}  v${event.config_version}{/grey-fg}`
      push(line, ['Adapt'])
    },

    onNews(event) {
      const color = event.direction === 'bullish' ? '{green-fg}' : event.direction === 'bearish' ? '{red-fg}' : '{grey-fg}'
      const line  =
        `${color}${ts(event.timestamp)} ${(event.pair || '?').padEnd(10)} ` +
        `${event.direction}/${event.confidence}  src=${event.source || '?'}{/${color.slice(1, -1)}}`
      push(line, ['News'])
    },

    onAdaptResult(data) {
      if (data.error) {
        pushAdapt(`{red-fg}${ts()} ADAPT  error: ${data.error}{/red-fg}`)
        return
      }
      for (const r of (data.results || [])) {
        if (r.error) {
          pushAdapt(`{red-fg}${ts()} ADAPT  ${r.agentId}  error: ${r.error}{/red-fg}`)
        } else if (r.skipped) {
          pushAdapt(`{grey-fg}${ts()} ADAPT  ${r.agentId}  skipped — ${r.effectiveExits}/5 effective exits{/grey-fg}`)
        } else if (!r.changes.length) {
          pushAdapt(`{grey-fg}${ts()} ADAPT  ${r.agentId}  no changes  reward=${r.reward.toFixed(4)}  Δ=${r.rewardDelta >= 0 ? '+' : ''}${r.rewardDelta.toFixed(4)}{/grey-fg}`)
        } else {
          const sign      = r.rewardDelta >= 0 ? '{green-fg}+' : '{red-fg}'
          const signClose = r.rewardDelta >= 0 ? '{/green-fg}' : '{/red-fg}'
          pushAdapt(
            `{cyan-fg}${ts()} ADAPT  ${r.agentId}  ${r.changes.length} param(s) updated` +
            `  reward=${r.reward.toFixed(4)}  Δ=${sign}${r.rewardDelta.toFixed(4)}${signClose}{/cyan-fg}`
          )
          for (const c of r.changes) {
            const dir = c.newVal > c.oldVal ? '{green-fg}↑{/green-fg}' : '{red-fg}↓{/red-fg}'
            pushAdapt(`{grey-fg}  └ ${c.path.split('.').pop().padEnd(24)} ${c.oldVal} → {/grey-fg}{white-fg}${c.newVal}{/white-fg} ${dir}`)
          }
        }
      }
    },

    onAdaptReset(data) {
      pushAdapt(`{yellow-fg}${ts()} ADAPT  posteriors reset — ${(data.agents || []).join(', ')}{/yellow-fg}`)
    },

    onMetaAdaptResult(promotions) {
      if (!promotions || !promotions.length) return
      for (const p of promotions) {
        pushAdapt(
          `{magenta-fg}${ts()} META   ${p.liveId}  ${p.changes.length} param(s) promoted from paper agents{/magenta-fg}`
        )
        for (const c of p.changes) {
          const dir   = c.newVal > c.oldVal ? '{green-fg}↑{/green-fg}' : '{red-fg}↓{/red-fg}'
          const delta = (c.teacherReward - c.liveReward).toFixed(4)
          pushAdapt(
            `{grey-fg}  └ ${c.path.split('.').pop().padEnd(24)} ${c.oldVal} → {/grey-fg}{white-fg}${c.newVal}{/white-fg}` +
            ` ${dir} {grey-fg}← ${c.teacher}  Δreward=+${delta}{/grey-fg}`
          )
        }
      }
    },

    append(msg) { push(msg, ['All']) },

    clear() {
      for (const t of TABS) _buffers[t] = []
      render()
    }
  }
}

module.exports = { create }
