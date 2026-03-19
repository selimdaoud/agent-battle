'use strict'

const VERSION = '1.0.4'

const blessed = require('blessed')
const { C }   = require('../../core/world')

const INITIAL_CAPITAL      = C.INITIAL_CAPITAL
const MEGA_INITIAL_CAPITAL = C.MEGA_SIM_CAPITAL
const SIM_START            = INITIAL_CAPITAL * 3  // $30,000 — A/B/G only (MEGA is always excluded)

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
    const realTrading   = snap.realTrading || false
    // MEGA is always excluded from sim P&L — its capital is never mixed with A/B/G
    const simAgents     = alive.filter(a => a.name !== 'MEGA')
    const megaLiveAgent = realTrading ? alive.find(a => a.name === 'MEGA') : null
    const simStart      = SIM_START

    const combinedFees     = allAgents.reduce((s, a) => s + (a.totalFees || 0), 0)
    const aliveTotal       = simAgents.reduce((s, a) => s + totalValue(a, prices), 0)
    const combinedCash     = simAgents.reduce((s, a) => s + a.capital, 0)
    const combinedCrypto   = aliveTotal - combinedCash
    const totalRecovered   = snap.totalRecovered || 0
    const atRisk           = snap.totalInjected ? snap.totalInjected - (realTrading ? INITIAL_CAPITAL : 0) : simStart
    const totalCommitted   = atRisk + totalRecovered
    const totalAssets      = aliveTotal + totalRecovered
    const pnlAmt           = totalAssets - totalCommitted
    const pnlPct           = (pnlAmt / totalCommitted * 100).toFixed(1)
    const pnlSign          = pnlAmt >= 0 ? '+' : ''
    const pnlColor         = pnlAmt >= 0 ? 'green' : 'red'
    const exposurePct      = aliveTotal > 0 ? (combinedCrypto / aliveTotal * 100).toFixed(0) : 0

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

    const respawnExtra = totalCommitted > simStart
      ? ` {magenta-fg}(+$${fmt(totalCommitted - simStart)} respawns){/magenta-fg}` : ''
    const recoveredExtra = totalRecovered > 0
      ? `   At Risk: {bold}$${fmt(atRisk)}{/bold}  {grey-fg}$${fmt(totalRecovered)} returned{/grey-fg}` : ''

    // MEGA LIVE line — real account stats shown separately
    const megaLiveLine = megaLiveAgent
      ? (() => {
          const mv    = totalValue(megaLiveAgent, prices)
          const mc    = megaLiveAgent.capital
          const mcr   = mv - mc
          const mpnl  = ((mv - MEGA_INITIAL_CAPITAL) / MEGA_INITIAL_CAPITAL * 100).toFixed(1)
          const mpCol = mpnl >= 0 ? 'green' : 'red'
          const mpSign = mpnl >= 0 ? '+' : ''
          return `   {yellow-fg}{bold}MEGA LIVE{/bold}: $${fmt(mv)}  P&L:{/yellow-fg}{${mpCol}-fg}{bold}${mpSign}${mpnl}%{/bold}{/${mpCol}-fg}  USDT:$${fmt(mc)}  Crypto:$${fmt(mcr)}{/yellow-fg}`
        })()
      : ''

    summary.setContent(
      ` {bold}PORTFOLIO OVERVIEW {grey-fg}(A/B/G sim){/grey-fg}{/bold}` +
      `   Committed: {bold}$${fmt(totalCommitted)}{/bold}${respawnExtra}${recoveredExtra}` +
      `   Total Assets: {bold}$${fmt(totalAssets)}{/bold}` +
      `   P&L: {${pnlColor}-fg}{bold}${pnlSign}$${fmt(pnlAmt)} (${pnlSign}${pnlPct}%){/bold}{/${pnlColor}-fg}` +
      `   Fees: {magenta-fg}$${combinedFees.toFixed(3)}{/magenta-fg}` +
      `   Cash: {bold}$${fmt(combinedCash)}{/bold}` +
      `   Crypto: {bold}$${fmt(combinedCrypto)}{/bold}` +
      `   Exposure: {bold}${exposurePct}%{/bold}` +
      `   ${leaderStr}${megaLiveLine}\n` +
      ` ${bar(combinedCash, combinedCrypto, aliveTotal)}\n` +
      `${consensusLine}\n` +
      `${winLine}`
    )

    // ── Individual agent boxes ────────────────────────────────────────────────
    for (const [name, agent] of Object.entries(snap.agents)) {
      const box = boxes[name]
      if (!box) continue

      const rank    = ranked.findIndex(a => a.name === name) + 1
      const total   = totalValue(agent, prices)
      const startCap = name === 'MEGA' ? MEGA_INITIAL_CAPITAL : INITIAL_CAPITAL
      const pnl     = ((total - startCap) / startCap * 100).toFixed(1)
      const pnlSign = pnl >= 0 ? '+' : ''
      const pnlCol  = pnl >= 0 ? 'green' : 'red'

      if (!agent.alive) {
        box.style.border.fg = 'grey'
        box.style.label.fg  = 'grey'
        box.setContent('{grey-fg}TERMINATED{/grey-fg}')
        continue
      }

      const defaultColor  = name === 'MEGA' ? (realTrading ? 'yellow' : 'grey') : 'cyan'
      const borderColor   = agent.threatened ? 'red' : defaultColor
      box.style.border.fg = borderColor
      box.style.label.fg  = borderColor

      const statusIcon = agent.threatened
        ? '{red-fg}⚠ THREATENED{/red-fg}'
        : (name === 'MEGA' && realTrading)
          ? '{yellow-fg}⚡ LIVE{/yellow-fg}'
          : name === 'MEGA'
            ? '{grey-fg}○ SIM{/grey-fg}'
            : '{green-fg}●{/green-fg}'
      const rankStr   = rank ? `#${rank}` : ''
      const holdLines = holdingLines(agent, prices, total, snap.round)

      const agentCrypto = total - agent.capital
      const agentExp    = total > 0 ? (agentCrypto / total * 100).toFixed(0) : 0

      const feesStr = agent.totalFees > 0
        ? `{red-fg}$${agent.totalFees.toFixed(3)}{/red-fg}`
        : '{grey-fg}$0.000{/grey-fg}'

      const shortSection = name === 'GAMMA'
        ? `─────────────────────\n${shortLines(agent, prices, snap.round)}\n`
        : ''

      box.setContent(
        `${statusIcon} ${rankStr}\n` +
        `survival: {bold}${agent.survivalScore.toFixed(3)}{/bold}   respawns: ${agent.respawnCount}\n` +
        `Total: {bold}$${fmt(total)}{/bold}  P&L: {${pnlCol}-fg}{bold}${pnlSign}${pnl}%{/bold}{/${pnlCol}-fg}\n` +
        `Cash: $${fmt(agent.capital)}  Crypto: $${fmt(agentCrypto)}  Exp: ${agentExp}%\n` +
        `Fees paid: ${feesStr}\n` +
        `─────────────────────\n` +
        `Holdings:\n${holdLines || '  (none)'}\n` +
        shortSection +
        `─────────────────────\n` +
        `${metricsLines(agent)}\n` +
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

// ── Trading quality metrics ───────────────────────────────────────────────────
function computeMetrics(agent) {
  const closed = agent.closedTrades || []
  const hist   = agent.portfolioHistory || []

  // 1. Expectancy per trade
  let expectancy = null, winRate = null, avgWin = null, avgLoss = null, expWarn = null
  if (closed.length < 6) {
    expWarn = `${6 - closed.length} more trades needed`
  } else {
    const wins   = closed.filter(t => t.return_pct > 0)
    const losses = closed.filter(t => t.return_pct <= 0)
    winRate  = wins.length / closed.length
    const lossRate = losses.length / closed.length
    avgWin   = wins.length   ? wins.reduce((s, t)   => s + t.return_pct, 0) / wins.length   : 0
    avgLoss  = losses.length ? Math.abs(losses.reduce((s, t) => s + t.return_pct, 0) / losses.length) : 0
    expectancy = (winRate * avgWin) - (lossRate * avgLoss)
  }

  // 2. Maximum drawdown from equity curve
  let maxDD = null, ddWarn = null
  if (hist.length < 2) {
    ddWarn = 'insufficient history'
  } else {
    let peak = hist[0], dd = 0
    for (let i = 1; i < hist.length; i++) {
      if (hist[i] > peak) peak = hist[i]
      const d = peak > 0 ? (hist[i] - peak) / peak : 0
      if (d < dd) dd = d
    }
    maxDD = dd * 100  // percentage, <= 0
  }

  // 3. Sharpe ratio (per-period, not annualised — simulation horizon too short)
  let sharpe = null, sharpeWarn = null
  if (hist.length < 3) {
    sharpeWarn = 'insufficient history'
  } else {
    const returns = []
    for (let i = 1; i < hist.length; i++) {
      if (hist[i - 1] > 0) returns.push(hist[i] / hist[i - 1] - 1)
    }
    if (returns.length < 2) {
      sharpeWarn = 'insufficient returns'
    } else {
      const mean  = returns.reduce((s, v) => s + v, 0) / returns.length
      const vari  = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1)
      const std   = Math.sqrt(vari)
      sharpe      = std === 0 ? null : mean / std
      if (sharpe === null) sharpeWarn = 'zero variance'
    }
  }

  return { expectancy, winRate, avgWin, avgLoss, expWarn,
           maxDD, ddWarn,
           sharpe, sharpeWarn,
           n: closed.length }
}

function metricsLines(agent) {
  const m = computeMetrics(agent)
  const lines = []

  // Expectancy
  if (m.expWarn) {
    lines.push(` {grey-fg}Exp: — (${m.expWarn}){/grey-fg}`)
  } else {
    const sign  = m.expectancy >= 0 ? '+' : ''
    const col   = m.expectancy >= 0 ? 'green' : 'red'
    const wr    = Math.round(m.winRate * 100)
    const aw    = m.avgWin.toFixed(2)
    const al    = m.avgLoss.toFixed(2)
    lines.push(` Exp: {${col}-fg}{bold}${sign}${m.expectancy.toFixed(3)}%{/bold}{/${col}-fg}` +
               `  {grey-fg}wr:${wr}% aw:${aw}% al:${al}% n:${m.n}{/grey-fg}`)
  }

  // Max drawdown
  if (m.ddWarn) {
    lines.push(` {grey-fg}MaxDD: — (${m.ddWarn}){/grey-fg}`)
  } else {
    const col = m.maxDD < -10 ? 'red' : m.maxDD < -5 ? 'yellow' : 'green'
    lines.push(` MaxDD: {${col}-fg}{bold}${m.maxDD.toFixed(2)}%{/bold}{/${col}-fg}`)
  }

  // Sharpe
  if (m.sharpeWarn) {
    lines.push(` {grey-fg}Sharpe: — (${m.sharpeWarn}){/grey-fg}`)
  } else {
    const col  = m.sharpe >= 1 ? 'green' : m.sharpe >= 0 ? 'yellow' : 'red'
    lines.push(` Sharpe: {${col}-fg}{bold}${m.sharpe.toFixed(3)}{/bold}{/${col}-fg}` +
               `  {grey-fg}(${agent.portfolioHistory?.length ?? 0} periods){/grey-fg}`)
  }

  return lines.join('\n')
}

// ── GAMMA short positions ─────────────────────────────────────────────────────
function shortLines(agent, prices, round) {
  const positions = agent.shortPositions || {}
  const pool      = agent.shortCapital   ?? 0
  const poolMax   = Math.round((agent.portfolioHistory?.[0] ?? 10000) * 0.20)
  const used      = poolMax - pool
  const poolColor = used / poolMax > 0.80 ? 'red' : used > 0 ? 'yellow' : 'grey'

  const poolLine = ` {grey-fg}Shorts{/grey-fg}  pool:{${poolColor}-fg}$${fmt(pool)}/$${fmt(poolMax)}{/${poolColor}-fg}`

  const posLines = Object.entries(positions).map(([pair, pos]) => {
    const now  = prices[pair]
    const spct = (pos.entryPrice && now)
      ? (pos.entryPrice - now) / pos.entryPrice * 100
      : null

    let pnlStr = ''
    if (spct !== null) {
      const sign  = spct >= 0 ? '+' : ''
      const col   = spct >= 0 ? 'green' : 'red'
      const flag  = spct <= -6 ? ' {bold}↑SL!{/bold}' : spct >= 8 ? ' {bold}↓TP?{/bold}' : ''
      pnlStr = ` {${col}-fg}${sign}${spct.toFixed(1)}%${flag}{/${col}-fg}`
    }
    const colVal  = pos.collateral ? `$${fmt(pos.collateral)}` : '?'
    const heldStr = (pos.entryRound != null && round != null)
      ? ` {grey-fg}${round - pos.entryRound}r{/grey-fg}`
      : ''
    return `  {red-fg}▼{/red-fg} ${(C.LABELS[pair] || pair).padEnd(10)} ${colVal}${pnlStr}${heldStr}`
  }).join('\n')

  return poolLine + (posLines ? '\n' + posLines : '\n  {grey-fg}(no open shorts){/grey-fg}')
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

module.exports = { create, VERSION }
