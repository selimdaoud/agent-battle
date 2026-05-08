'use strict'

// tools/AnalyzeThis.js — AI-generated trading session analysis
//
// Usage:
//   node tools/AnalyzeThis.js              # last 12h (default)
//   node tools/AnalyzeThis.js --hours 6    # last 6h
//   node tools/AnalyzeThis.js --hours 24   # last 24h
//
// Output:
//   Printed to stdout + saved to v2/data/session-reports/YYYY-MM-DD-HHh.md

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const fs       = require('fs')
const path     = require('path')
const Database = require('better-sqlite3')
const { OpenAI } = require('openai')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2)
const hours = parseInt(args[args.indexOf('--hours') + 1] || '12', 10)
const since = Date.now() - hours * 3600 * 1000

const DB_PATH     = path.join(__dirname, '../data/events.db')
const STATES_DIR  = path.join(__dirname, '../data/agent-states')
const MACRO_PATH  = path.join(__dirname, '../data/macro-signal.json')
const REPORTS_DIR = path.join(__dirname, '../data/session-reports')

// ── Data collection ───────────────────────────────────────────────────────────

function collectData() {
  const db = new Database(DB_PATH, { readonly: true })

  // All entries in window
  const entries = db.prepare(`
    SELECT agent_id, mode, pair, price, size_usd, entry_score, config_version,
           timestamp, datetime(timestamp/1000,'unixepoch') as ts
    FROM entries WHERE timestamp >= ?
    ORDER BY timestamp
  `).all(since)

  // All exits in window
  const exits = db.prepare(`
    SELECT agent_id, mode, pair, exit_price, pnl_pct, exit_reason, holding_rounds, config_version,
           timestamp, datetime(timestamp/1000,'unixepoch') as ts
    FROM exits WHERE timestamp >= ?
    ORDER BY timestamp
  `).all(since)

  // All entries ever (to match exits to their entry, even if entry predates window)
  const allEntries = db.prepare(`
    SELECT agent_id, pair, price, size_usd, entry_score, timestamp,
           datetime(timestamp/1000,'unixepoch') as ts
    FROM entries ORDER BY timestamp
  `).all()

  // All exits ever (for capital curve)
  const allExits = db.prepare(`
    SELECT agent_id, pair, pnl_pct, timestamp,
           datetime(timestamp/1000,'unixepoch') as ts
    FROM exits ORDER BY timestamp
  `).all()

  // Last 10 exits before window (context)
  const recentExits = db.prepare(`
    SELECT agent_id, mode, pair, exit_price, pnl_pct, exit_reason, holding_rounds,
           datetime(timestamp/1000,'unixepoch') as ts
    FROM exits WHERE timestamp < ?
    ORDER BY timestamp DESC LIMIT 10
  `).all(since)

  // Latest price per pair
  const prices = {}
  db.prepare(`
    SELECT pair, mid FROM ticks
    WHERE (pair, timestamp) IN (SELECT pair, MAX(timestamp) FROM ticks GROUP BY pair)
  `).all().forEach(r => { prices[r.pair] = r.mid })

  // Latest tick timestamp
  const lastTick = db.prepare(
    `SELECT datetime(MAX(timestamp)/1000,'unixepoch') as ts FROM ticks`
  ).get()

  // Exit reason breakdown in window
  const exitReasons = db.prepare(`
    SELECT exit_reason, COUNT(*) as n,
           ROUND(AVG(pnl_pct),3) as avg_pnl,
           ROUND(MIN(pnl_pct),3) as min_pnl,
           ROUND(MAX(pnl_pct),3) as max_pnl
    FROM exits WHERE timestamp >= ?
    GROUP BY exit_reason
  `).all(since)

  // P&L summary per agent in window
  const agentPnl = db.prepare(`
    SELECT agent_id, mode,
           COUNT(*) as trades,
           ROUND(SUM(pnl_pct),3) as total_pnl,
           ROUND(AVG(pnl_pct),3) as avg_pnl,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins
    FROM exits WHERE timestamp >= ?
    GROUP BY agent_id, mode
    ORDER BY mode DESC, agent_id
  `).all(since)

  // All ticks for regime lookup (pair → sorted array)
  const allTicks = db.prepare(
    `SELECT pair, timestamp, p_trending_up, p_ranging, p_volatile FROM ticks ORDER BY pair, timestamp`
  ).all()

  db.close()

  // ── Tick regime lookup ─────────────────────────────────────────────────────
  // For a given pair and timestamp, find the closest tick at or before it.
  const ticksByPair = {}
  for (const t of allTicks) {
    if (!ticksByPair[t.pair]) ticksByPair[t.pair] = []
    ticksByPair[t.pair].push(t)
  }
  function regimeAtEntry(pair, entryTs) {
    const ticks = ticksByPair[pair] || []
    let best = null
    for (const t of ticks) {
      if (t.timestamp <= entryTs) best = t
      else break
    }
    if (!best) return null
    return {
      p_trending_up:   +best.p_trending_up.toFixed(3),
      p_ranging:       +best.p_ranging.toFixed(3),
      p_volatile:      +best.p_volatile.toFixed(3)
    }
  }

  // ── Capital curve per live agent ────────────────────────────────────────────
  // Reconstruct $-capital at each exit event. Start from INITIAL_CAPITAL=$5000,
  // apply each exit's pnl_usd (size_usd from matching entry × pnl_pct / 100).
  const INITIAL_CAPITAL = 5000
  const LIVE_AGENTS     = ['A1', 'A2', 'A3']
  const capitalCurves   = {}

  for (const agentId of LIVE_AGENTS) {
    let capital = INITIAL_CAPITAL
    const events = []  // {ts, pair, pnl_pct, pnl_usd, capital, in_window}

    for (const x of allExits.filter(e => e.agent_id === agentId)) {
      const entry = allEntries
        .filter(e => e.agent_id === agentId && e.pair === x.pair && e.timestamp < x.timestamp)
        .slice(-1)[0]
      const size_usd = entry?.size_usd ?? 0
      const pnl_usd  = +(size_usd * x.pnl_pct / 100).toFixed(2)
      capital = +(capital + pnl_usd).toFixed(2)

      if (x.timestamp >= since) {
        events.push({ ts: x.ts, pair: x.pair, pnl_pct: x.pnl_pct, pnl_usd, capital })
      }
    }

    // Capital at window start = capital before first in-window exit
    const capitalAtStart = events.length > 0
      ? +(events[0].capital - events[0].pnl_usd).toFixed(2)
      : capital  // no exits in window → current capital = start capital

    capitalCurves[agentId] = { capitalAtStart, events }
  }

  // ── Reconstruct trading rounds ─────────────────────────────────────────────
  // For each exit in the window, find its matching entry (most recent entry
  // for same agent+pair before that exit timestamp). Enrich with entry regime.
  const rounds = []
  for (const x of exits) {
    const matchingEntry = allEntries
      .filter(e => e.agent_id === x.agent_id && e.pair === x.pair && e.timestamp < x.timestamp)
      .slice(-1)[0]

    const entryInWindow = matchingEntry ? matchingEntry.timestamp >= since : false
    const holdMinutes   = matchingEntry
      ? Math.round((x.timestamp - matchingEntry.timestamp) / 60000)
      : null

    // Regime at entry — even if entry predates window
    const entryRegime = matchingEntry
      ? regimeAtEntry(x.pair, matchingEntry.timestamp)
      : null

    rounds.push({
      agent_id:        x.agent_id,
      mode:            x.mode,
      pair:            x.pair,
      entry_ts:        matchingEntry?.ts    ?? '(unknown)',
      exit_ts:         x.ts,
      entry_price:     matchingEntry?.price ?? null,
      exit_price:      x.exit_price,
      pnl_pct:         x.pnl_pct,
      exit_reason:     x.exit_reason,
      holding_rounds:  x.holding_rounds,
      hold_minutes:    holdMinutes,
      entry_in_window: entryInWindow,
      entry_regime:    entryRegime   // {p_trending_up, p_ranging, p_volatile} at entry tick
    })
  }

  // ── Re-entry detection ─────────────────────────────────────────────────────
  // Find cases where an agent exits a pair then re-enters the same pair within
  // the window. Computes: time gap (minutes) and price delta (%).
  const reentries = []
  for (const x of exits) {
    const nextEntry = entries.find(
      e => e.agent_id === x.agent_id && e.pair === x.pair && e.timestamp > x.timestamp
    )
    if (nextEntry) {
      const gapMin   = Math.round((nextEntry.timestamp - x.timestamp) / 60000)
      const priceDelta = nextEntry.price && x.exit_price
        ? +((nextEntry.price - x.exit_price) / x.exit_price * 100).toFixed(3)
        : null
      reentries.push({
        agent_id:    x.agent_id,
        pair:        x.pair,
        exit_ts:     x.ts,
        exit_price:  x.exit_price,
        exit_pnl:    x.pnl_pct,
        reentry_ts:  nextEntry.ts,
        reentry_price: nextEntry.price,
        gap_min:     gapMin,
        price_delta: priceDelta   // positive = re-entered higher (worse for buyer)
      })
    }
  }

  // ── Simultaneous actions detection ────────────────────────────────────────
  // Group exits by timestamp to find ticks where multiple agents act together.
  const exitsByTick = {}
  for (const x of exits) {
    if (!exitsByTick[x.timestamp]) exitsByTick[x.timestamp] = []
    exitsByTick[x.timestamp].push(x)
  }
  const simultaneousExits = Object.entries(exitsByTick)
    .filter(([, group]) => group.length > 1)
    .map(([ts, group]) => ({
      ts:      group[0].ts,
      agents:  group.map(x => x.agent_id).join(', '),
      pairs:   [...new Set(group.map(x => x.pair))].join(', '),
      count:   group.length,
      pnls:    group.map(x => `${x.pair} ${x.pnl_pct >= 0 ? '+' : ''}${x.pnl_pct}%`).join(' | ')
    }))

  // ── Live agent states ──────────────────────────────────────────────────────
  const agentStates = {}
  if (fs.existsSync(STATES_DIR)) {
    for (const file of fs.readdirSync(STATES_DIR)) {
      if (!file.endsWith('.json')) continue
      try {
        const state = JSON.parse(fs.readFileSync(path.join(STATES_DIR, file), 'utf8'))
        const id = file.replace('.json', '')
        agentStates[id] = {
          capital:   Math.round(state.capital),
          positions: Object.entries(state.positions || {}).map(([pair, pos]) => ({
            pair,
            entryPrice:    pos.entryPrice,
            sizeUsd:       Math.round(pos.sizeUsd),
            currentPrice:  prices[pair] || null,
            unrealisedPct: prices[pair]
              ? +((prices[pair] - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)
              : null
          }))
        }
      } catch { /* skip malformed */ }
    }
  }

  // Macro signal
  let macro = null
  if (fs.existsSync(MACRO_PATH)) {
    try { macro = JSON.parse(fs.readFileSync(MACRO_PATH, 'utf8')) } catch { /* skip */ }
  }

  return {
    entries, exits, recentExits, prices, lastTick,
    exitReasons, agentPnl, agentStates, macro,
    rounds, reentries, simultaneousExits, capitalCurves
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function fmt(n, decimals = 4) { return n != null ? n.toFixed(decimals) : '?' }
function pct(n) { return n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(3)}%` : '?' }

function buildPrompt(data, hours) {
  const {
    entries, recentExits, prices, lastTick,
    exitReasons, agentPnl, agentStates, macro,
    rounds, reentries, simultaneousExits, capitalCurves
  } = data

  const lines = []

  // ── System context ──────────────────────────────────────────────────────────
  lines.push(`## System context`)
  lines.push(`6 trading agents (A1–A6), 15 Binance pairs, $5000 capital/live agent, 15m candles.`)
  lines.push(`- LIVE (state persists): A1, A2, A3`)
  lines.push(`- PAPER (reset on restart, teach live agents via adaptation): A4, A5, A6`)
  lines.push(`- A1/A2/A4/A5/A6: trend_follow_mode — buy dip in macro uptrend, exit on macro flip`)
  lines.push(`- A3: spot_accum_mode — accumulate BTC when 4h macro recovers from capitulation (<0.20)`)
  lines.push(`- A4: scalper variant — stop 3%, TP 10%, deadweight 10r, aggressive Kelly (cap 2.5x, min 5 trades)`)
  lines.push(`- Exit types: macro_exit (4h macro_p_trending_up < 0.45), stop_loss, take_profit, deadweight, signal`)
  lines.push(``)

  // ── Macro ───────────────────────────────────────────────────────────────────
  lines.push(`## Macro environment`)
  if (macro) {
    lines.push(`DXY ${macro.dxy?.toFixed(1)} | trend: ${macro.trend} | advice: ${macro.advice} | paused: ${macro.trading_paused}`)
  }
  lines.push(`Last candle: ${lastTick?.ts || 'unknown'}`)
  lines.push(``)

  // ── Open positions ──────────────────────────────────────────────────────────
  lines.push(`## Open positions (live agents)`)
  for (const id of ['A1', 'A2', 'A3']) {
    const state = agentStates[id]
    if (!state) { lines.push(`${id}: no state file`); continue }
    if (state.positions.length === 0) {
      lines.push(`${id}: flat | capital $${state.capital}`)
    } else {
      for (const pos of state.positions) {
        lines.push(`${id}: ${pos.pair} | entry $${fmt(pos.entryPrice)} | now $${fmt(pos.currentPrice)} | unrealised ${pct(pos.unrealisedPct)} | size $${pos.sizeUsd} | capital $${state.capital}`)
      }
    }
  }
  lines.push(``)

  // ── P&L summary ─────────────────────────────────────────────────────────────
  lines.push(`## P&L summary — last ${hours}h`)
  if (agentPnl.length === 0) {
    lines.push(`No closed trades.`)
  } else {
    for (const r of agentPnl) {
      lines.push(`${r.agent_id} (${r.mode}): ${r.trades} trades | net ${pct(r.total_pnl)} | avg ${pct(r.avg_pnl)} | ${r.wins}/${r.trades} wins`)
    }
  }
  lines.push(``)

  // ── Exit reasons ────────────────────────────────────────────────────────────
  lines.push(`## Exit reason breakdown`)
  for (const r of exitReasons) {
    lines.push(`${r.exit_reason}: ${r.n}x | avg ${pct(r.avg_pnl)} | range [${pct(r.min_pnl)}, ${pct(r.max_pnl)}]`)
  }
  lines.push(``)

  // ── Capital trajectory (live agents) ────────────────────────────────────────
  lines.push(`## Capital trajectory — live agents`)
  lines.push(`(Reconstructed from all historical exits. Shows capital at window start, then each exit event.)`)
  for (const id of ['A1', 'A2', 'A3']) {
    const curve = capitalCurves[id]
    if (!curve) { lines.push(`${id}: no data`); continue }
    const delta = +(curve.events.reduce((s, e) => s + e.pnl_usd, 0)).toFixed(2)
    const sign  = delta >= 0 ? '+' : ''
    lines.push(`\n${id}: capital at window start $${curve.capitalAtStart}  →  net this session ${sign}$${delta}`)
    if (curve.events.length === 0) {
      lines.push(`  (no closed trades in window)`)
    } else {
      for (const e of curve.events) {
        lines.push(`  ${e.ts} | ${e.pair} | ${pct(e.pnl_pct)} | P&L $${e.pnl_usd >= 0 ? '+' : ''}${e.pnl_usd} | capital → $${e.capital}`)
      }
    }
  }
  lines.push(``)

  // ── Trading rounds (pre-computed entry→exit pairs) ──────────────────────────
  lines.push(`## Trading rounds — last ${hours}h`)
  lines.push(`(Each row = one completed position: entry price → exit price, with P&L and reason)`)
  if (rounds.length === 0) {
    lines.push(`No completed rounds.`)
  } else {
    // Group by agent for readability
    const byAgent = {}
    for (const r of rounds) {
      if (!byAgent[r.agent_id]) byAgent[r.agent_id] = []
      byAgent[r.agent_id].push(r)
    }
    for (const [agent, agRounds] of Object.entries(byAgent).sort()) {
      lines.push(`\n${agent} (${agRounds[0].mode}):`)
      for (const r of agRounds) {
        const entryLabel = r.entry_in_window ? r.entry_ts : `${r.entry_ts} [before window]`
        const regimeStr  = r.entry_regime
          ? `macro↑${(r.entry_regime.p_trending_up * 100).toFixed(0)}% rng${(r.entry_regime.p_ranging * 100).toFixed(0)}%`
          : 'regime=?'
        const holdStr    = r.hold_minutes != null ? `${r.hold_minutes}min` : `${r.holding_rounds}r`
        lines.push(
          `  ${r.pair.padEnd(10)} | entry ${entryLabel} @ $${fmt(r.entry_price)} [${regimeStr}]` +
          ` → exit ${r.exit_ts} @ $${fmt(r.exit_price)} | ${pct(r.pnl_pct)} | ${r.exit_reason} | held ${holdStr}`
        )
      }
    }
  }
  lines.push(``)

  // ── Re-entry analysis ───────────────────────────────────────────────────────
  lines.push(`## Re-entry analysis`)
  lines.push(`(Cases where an agent exited a pair then re-entered the same pair within the window)`)
  if (reentries.length === 0) {
    lines.push(`No re-entries detected.`)
  } else {
    for (const r of reentries) {
      const deltaLabel = r.price_delta != null
        ? `re-entered ${r.price_delta >= 0 ? '+' : ''}${r.price_delta}% vs exit price`
        : ''
      lines.push(
        `${r.agent_id} | ${r.pair} | exited ${r.exit_ts} @ $${fmt(r.exit_price)} (${pct(r.exit_pnl)})` +
        ` → re-entered ${r.reentry_ts} @ $${fmt(r.reentry_price)} | gap: ${r.gap_min}min | ${deltaLabel}`
      )
    }
  }
  lines.push(``)

  // ── Simultaneous exits ──────────────────────────────────────────────────────
  lines.push(`## Simultaneous exits (correlation signal)`)
  lines.push(`(Multiple agents exiting at the exact same candle)`)
  if (simultaneousExits.length === 0) {
    lines.push(`No simultaneous exits.`)
  } else {
    for (const s of simultaneousExits) {
      lines.push(`${s.ts} | ${s.count} agents [${s.agents}] | ${s.pnls}`)
    }
  }
  lines.push(``)

  // ── New entries in window ───────────────────────────────────────────────────
  lines.push(`## New entries opened in window`)
  if (entries.length === 0) {
    lines.push(`No new entries.`)
  } else {
    for (const e of entries) {
      lines.push(`${e.ts} | ${e.agent_id} (${e.mode}) | ${e.pair} @ $${fmt(e.price)} | size $${Math.round(e.size_usd)} | score ${fmt(e.entry_score, 3)}`)
    }
  }
  lines.push(``)

  // ── Context: exits before window ────────────────────────────────────────────
  lines.push(`## Context: last 10 exits before this window`)
  for (const x of recentExits.slice().reverse()) {
    lines.push(`${x.ts} | ${x.agent_id} | ${x.pair} | ${pct(x.pnl_pct)} | ${x.exit_reason} | ${x.holding_rounds}r`)
  }

  return lines.join('\n')
}

// ── AI analysis ───────────────────────────────────────────────────────────────

async function generateAnalysis(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: [
          'You are a quantitative trading analyst reviewing an adaptive multi-agent crypto trading simulation.',
          'You receive structured raw data about the last N hours of live operation.',
          'Write a concise, insightful session report in Markdown.',
          '',
          'Structure your report as follows:',
          '1. **Session Summary** — one paragraph, what happened overall',
          '2. **Agent Performance** — per-agent breakdown (live agents first), capital, P&L, notable behaviors',
          '3. **Trade Analysis** — winners, losers, exit patterns, timing observations',
          '4. **Macro & Regime** — how the 4h macro signal influenced decisions, oscillation patterns',
          '5. **Alerts & Risks** — positions to watch, correlations, anything concerning',
          '6. **Observations** — non-obvious patterns worth noting for system improvement',
          '',
          'Be direct and specific. Use the exact numbers from the data. No padding.',
          '',
          'The data includes pre-computed sections — use them:',
          '- "Capital trajectory": shows each live agent\'s capital at window start, then after each closed trade. Use this to describe the intraday P&L arc, not just the final number.',
          '- "Trading rounds": each completed position with entry price, exit price, P&L, reason, AND regime at entry (macro↑ = 4h trend probability, rng = ranging probability). Use this for trade analysis. Flag entries where macro↑ was already low (<50%) — those were risky setups.',
          '- "Re-entry analysis": when an agent exits a pair then re-enters it. Pay attention to the gap (minutes) and price delta — re-entering higher after a flush is a risk (agent buying back at a worse price).',
          '- "Simultaneous exits": multiple agents exiting at the exact same candle. Flag this as a correlation risk if it recurs.',
          '',
          'Flag explicitly if macro_exit dominates (>80% of exits) — known pattern, indicate if it causes churn.',
          'Flag re-entries where price_delta > 0 (re-entered at a higher price than exit) — this is buying back worse.',
          'If multiple rounds on the same pair show exit → re-entry → exit within hours, call it an oscillation/churn cycle.',
        ].join('\n')
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  })

  return response.choices[0].message.content
}

// ── Save report ───────────────────────────────────────────────────────────────

function saveReport(content, hours) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true })

  const now   = new Date()
  const stamp = now.toISOString().slice(0, 13).replace('T', '-') + 'h'
  const file  = path.join(REPORTS_DIR, `${stamp}.md`)

  const header = `# Session Report — last ${hours}h\n_Generated: ${now.toISOString()}_\n\n`
  fs.writeFileSync(file, header + content)
  return file
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set in .env')
    process.exit(1)
  }

  console.log(`Collecting data (last ${hours}h)...`)
  const data   = collectData()
  const prompt = buildPrompt(data, hours)

  console.log(`Sending to gpt-4o...`)
  const report = await generateAnalysis(prompt)

  const file = saveReport(report, hours)

  console.log('\n' + '═'.repeat(72))
  console.log(report)
  console.log('═'.repeat(72))
  console.log(`\nSaved → ${file}`)
}

main().catch(err => { console.error(err); process.exit(1) })
