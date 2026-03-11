'use strict'

const blessed = require('blessed')
const { C }   = require('../../core/world')

const INITIAL_CAPITAL = C.INITIAL_CAPITAL
const TOTAL_START     = INITIAL_CAPITAL * 4  // $40,000 combined (4 agents)

function create(parent) {
  const boxes = {}

  // ── Aggregate summary bar (top 5 lines of the parent) ──────────────────────
  const summary = blessed.box({
    parent,
    top:    0,
    left:   0,
    width:  '100%',
    height: 5,
    style:  { bg: 'black' },
    tags:   true
  })

  // ── Win-rate + consensus state ──────────────────────────────────────────────
  const winCounts     = { ALPHA: 0, BETA: 0, GAMMA: 0, MEGA: 0 }
  let   totalRounds   = 0
  let   lastConsensus = { pct: 0, action: 'HOLD', divergent: false, label: '' }

  // ── Agent boxes — shifted down by 5 to make room for summary bar ───────────
  const names = ['ALPHA', 'BETA', 'GAMMA', 'MEGA']
  const w     = Math.floor(100 / 4)

  for (let i = 0; i < 4; i++) {
    const name      = names[i]
    const baseColor = name === 'MEGA' ? 'yellow' : 'cyan'
    boxes[name] = blessed.box({
      parent,
      label:  ` ${name} `,
      top:    5,
      left:   `${i * w}%`,
      width:  i < 3 ? `${w}%` : '25%',
      height: '100%-6',
      border: { type: 'line' },
      style:  { border: { fg: baseColor }, label: { fg: baseColor, bold: true } },
      tags:       true,
      scrollable: true
    })
  }

  function update(snap, prices, decisions) {
    if (!snap) return
    prices    = prices    || {}
    decisions = decisions || []

    const allAgents = Object.values(snap.agents)
    const alive     = allAgents.filter(a => a.alive)

    const ranked = alive.slice().sort((a, b) =>
      totalValue(b, prices) - totalValue(a, prices)
    )

    // ── Aggregate calculations ────────────────────────────────────────────────
    const combinedTotal    = allAgents.reduce((s, a) => s + totalValue(a, prices), 0)
    const combinedFees     = allAgents.reduce((s, a) => s + (a.totalFees || 0), 0)
    const combinedCash     = allAgents.reduce((s, a) => s + a.capital, 0)
    const combinedCrypto   = combinedTotal - combinedCash
    const totalInjected    = snap.totalInjected || TOTAL_START
    const combinedPnl      = ((combinedTotal - totalInjected) / totalInjected * 100).toFixed(1)
    const pnlSign        = combinedPnl >= 0 ? '+' : ''
    const pnlColor       = combinedPnl >= 0 ? 'green' : 'red'
    const exposurePct    = combinedTotal > 0 ? (combinedCrypto / combinedTotal * 100).toFixed(0) : 0

    // Leader + win tracking
    const leader = ranked[0]
    if (leader && winCounts[leader.name] !== undefined) {
      totalRounds++
      winCounts[leader.name]++
    }
    const leaderStr = leader
      ? `Leader: {bold}${leader.name}{/bold} $${fmt(totalValue(leader, prices))}`
      : 'No leader'

    // ── Consensus meter ───────────────────────────────────────────────────────
    if (decisions.length > 0) {
      const counts = { BUY: 0, SELL: 0, HOLD: 0 }
      const agentLabels = []
      decisions.forEach(d => {
        const action = d.trade?.action || d.decision?.action || 'HOLD'
        counts[action] = (counts[action] || 0) + 1
        const arrow = action === 'BUY' ? '{green-fg}▲{/green-fg}' : action === 'SELL' ? '{red-fg}▼{/red-fg}' : '{grey-fg}─{/grey-fg}'
        agentLabels.push(`${d.agent}${arrow}`)
      })
      const sorted    = Object.entries(counts).sort((a, b) => b[1] - a[1])
      const topAction = sorted[0]
      const pct       = Math.round(topAction[1] / decisions.length * 100)
      const divergent = topAction[1] < decisions.length  // not unanimous
      lastConsensus   = { pct, action: topAction[0], divergent, label: agentLabels.join(' ') }
    }

    // ── Consensus line ────────────────────────────────────────────────────────
    const cColor   = lastConsensus.action === 'BUY' ? 'green' : lastConsensus.action === 'SELL' ? 'red' : 'yellow'
    const cBarFill = Math.round(lastConsensus.pct / 100 * 20)
    const cBar     = `{${cColor}-fg}${'█'.repeat(cBarFill)}${'░'.repeat(20 - cBarFill)}{/${cColor}-fg}`
    const divAlert = lastConsensus.divergent
      ? ' {red-fg}⚡ DIVERGENCE{/red-fg}'
      : ' {green-fg}✓ consensus{/green-fg}'
    const consensusLine =
      ` Consensus: ${cBar} {bold}${lastConsensus.pct}% ${lastConsensus.action}{/bold}${divAlert}   ${lastConsensus.label}`

    // ── Win-rate line ─────────────────────────────────────────────────────────
    const winLine = ' Win Rate: ' + names.map(n => {
      const pct = totalRounds > 0 ? Math.round(winCounts[n] / totalRounds * 100) : 0
      const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
      const col  = n === leader?.name ? 'green' : 'cyan'
      return `{${col}-fg}{bold}${n}{/bold} ${bar} ${pct}%{/${col}-fg}`
    }).join('   ')

    const totalRecovered  = snap.totalRecovered || 0
    const grossInjected   = totalInjected + totalRecovered  // before recovery deductions
    const parts = []
    if (grossInjected > TOTAL_START) parts.push(`{magenta-fg}+$${fmt(grossInjected - TOTAL_START)} injected{/magenta-fg}`)
    if (totalRecovered > 0)          parts.push(`{grey-fg}-$${fmt(totalRecovered)} recovered{/grey-fg}`)
    const injectedExtra = parts.length ? ` (${parts.join('  ')})` : ''

    summary.setContent(
      ` {bold}PORTFOLIO OVERVIEW{/bold}` +
      `   Invested: {bold}$${fmt(totalInjected)}{/bold}${injectedExtra}` +
      `   Total: {bold}$${fmt(combinedTotal)}{/bold}` +
      `   Fees: {magenta-fg}$${combinedFees.toFixed(3)}{/magenta-fg}` +
      `   P&L: {${pnlColor}-fg}{bold}${pnlSign}${combinedPnl}%{/bold}{/${pnlColor}-fg}` +
      `   Cash: {bold}$${fmt(combinedCash)}{/bold}` +
      `   Crypto: {bold}$${fmt(combinedCrypto)}{/bold}` +
      `   Exposure: {bold}${exposurePct}%{/bold}` +
      `   ${leaderStr}\n` +
      ` ${bar(combinedCash, combinedCrypto, combinedTotal)}\n` +
      `${consensusLine}\n` +
      `${winLine}`
    )

    // ── Individual agent boxes ────────────────────────────────────────────────
    for (const [name, agent] of Object.entries(snap.agents)) {
      const box = boxes[name]
      if (!box) continue

      const rank    = ranked.findIndex(a => a.name === name) + 1
      const total   = totalValue(agent, prices)
      const pnl     = ((total - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1)
      const pnlSign = pnl >= 0 ? '+' : ''
      const pnlCol  = pnl >= 0 ? 'green' : 'red'

      if (!agent.alive) {
        box.style.border.fg = 'grey'
        box.style.label.fg  = 'grey'
        box.setContent('{grey-fg}TERMINATED{/grey-fg}')
        continue
      }

      const defaultColor  = name === 'MEGA' ? 'yellow' : 'cyan'
      const borderColor   = agent.threatened ? 'red' : defaultColor
      box.style.border.fg = borderColor
      box.style.label.fg  = borderColor

      const statusIcon = agent.threatened
        ? '{red-fg}⚠ THREATENED{/red-fg}'
        : '{green-fg}●{/green-fg}'
      const rankStr   = rank ? `#${rank}` : ''
      const holdLines = holdingLines(agent, prices, total, snap.round)

      const agentCrypto = total - agent.capital
      const agentExp    = total > 0 ? (agentCrypto / total * 100).toFixed(0) : 0

      const feesStr = agent.totalFees > 0
        ? `{red-fg}$${agent.totalFees.toFixed(3)}{/red-fg}`
        : '{grey-fg}$0.000{/grey-fg}'

      box.setContent(
        `${statusIcon} ${rankStr}\n` +
        `survival: {bold}${agent.survivalScore.toFixed(3)}{/bold}   respawns: ${agent.respawnCount}\n` +
        `Total: {bold}$${fmt(total)}{/bold}  P&L: {${pnlCol}-fg}{bold}${pnlSign}${pnl}%{/bold}{/${pnlCol}-fg}\n` +
        `Cash: $${fmt(agent.capital)}  Crypto: $${fmt(agentCrypto)}  Exp: ${agentExp}%\n` +
        `Fees paid: ${feesStr}\n` +
        `─────────────────────\n` +
        `Holdings:\n${holdLines || '  (none)'}\n` +
        `─────────────────────\n` +
        `{cyan-fg}"${agent.personality || '…'}"{/cyan-fg}`
      )

      flashBorder(box, 'yellow', 200)
    }

    parent.screen.render()
  }

  function flashBorder(box, color, ms) {
    const orig = box.style.border.fg
    box.style.border.fg = color
    setTimeout(() => { box.style.border.fg = orig; parent.screen.render() }, ms)
  }

  return { update }
}

// ── Cash/crypto allocation bar (36 chars wide) ────────────────────────────────
function bar(cash, crypto, total) {
  if (total <= 0) return ''
  const WIDTH     = 36
  const cryptoW   = Math.round((crypto / total) * WIDTH)
  const cashW     = WIDTH - cryptoW
  const cryptoBar = '{green-fg}' + '█'.repeat(cryptoW) + '{/green-fg}'
  const cashBar   = '{grey-fg}' + '░'.repeat(cashW)   + '{/grey-fg}'
  const cryptoPct = (crypto / total * 100).toFixed(0)
  const cashPct   = (cash   / total * 100).toFixed(0)
  return `${cryptoBar}${cashBar}  {green-fg}crypto ${cryptoPct}%{/green-fg}  {grey-fg}cash ${cashPct}%{/grey-fg}`
}

function totalValue(agent, prices) {
  let v = agent.capital
  for (const [pair, qty] of Object.entries(agent.holdings || {})) {
    if (qty > 0 && prices[pair]) v += qty * prices[pair]
  }
  return v
}

function holdingLines(agent, prices, agentTotal, round) {
  return Object.entries(agent.holdings || {})
    .filter(([, q]) => q > 0)
    .map(([p, q]) => {
      const entry      = agent.entryPrices?.[p]
      const now        = prices[p]
      const val        = now ? q * now : null
      const pct        = (entry && now) ? (now - entry) / entry * 100 : null
      const allocPct   = (val != null && agentTotal > 0) ? Math.round(val / agentTotal * 100) : null
      const ticksHeld  = (agent.entryRounds?.[p] != null && round != null)
                         ? round - agent.entryRounds[p] : null

      const valStr  = val != null ? `$${fmt(val)}` : `${q.toFixed(4)} units`
      const allocStr = allocPct != null ? ` {grey-fg}${allocPct}%{/grey-fg}` : ''
      const heldStr  = ticksHeld != null
        ? (ticksHeld >= 5 ? ` {yellow-fg}${ticksHeld}r{/yellow-fg}` : ` {grey-fg}${ticksHeld}r{/grey-fg}`)
        : ''

      let pnlStr = ''
      if (pct !== null) {
        const sign  = pct >= 0 ? '+' : ''
        const color = pct >= 20 ? 'green' : pct > 0 ? 'green' : pct <= -6 ? 'red' : 'red'
        const flag  = pct >= 20 ? ' {bold}↑TP?{/bold}' : pct <= -6 ? ' {bold}↓SL!{/bold}' : ''
        pnlStr = ` {${color}-fg}${sign}${pct.toFixed(1)}%${flag}{/${color}-fg}`
      }

      return `  ${(C.LABELS[p] || p).padEnd(10)} ${valStr}${pnlStr}${allocStr}${heldStr}`
    }).join('\n')
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

module.exports = { create }
