'use strict'

// tools/analyze.js — Diagnose replay results.
//
// Usage:
//   node tools/analyze.js                                          # defaults
//   node tools/analyze.js --src ./data/replay.db                  # replay DB
//   node tools/analyze.js --ticks ./data/backtest.db              # signal breakdown
//   node tools/analyze.js --agent A1                              # single agent
//   node tools/analyze.js --mode live                             # live only
//
// Output sections:
//   1. Overall summary per agent
//   2. Exit reason breakdown — what is killing P&L
//   3. Entry score buckets — does a higher score actually predict a win?
//   4. Regime analysis — which market condition works / fails
//   5. Holding time — do winners hold longer or shorter than losers?
//   6. Signal values at entry — winners vs losers (requires --ticks)
//   7. Recommendations

require('dotenv').config()

const Database = require('better-sqlite3')

const log  = (...a) => process.stdout.write(a.join(' ') + '\n')
const SEP  = '─'.repeat(72)
const SEP2 = '═'.repeat(72)

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { src: './data/replay.db', ticks: './data/backtest.db', agent: null, mode: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src'   && argv[i+1]) { args.src   = argv[++i]; continue }
    if (argv[i] === '--ticks' && argv[i+1]) { args.ticks = argv[++i]; continue }
    if (argv[i] === '--agent' && argv[i+1]) { args.agent = argv[++i]; continue }
    if (argv[i] === '--mode'  && argv[i+1]) { args.mode  = argv[++i]; continue }
  }
  return args
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function mean(a)    { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0 }
function median(a)  {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2
}
function pct(n, d)  { return d ? (n / d * 100).toFixed(1) + '%' : '—' }
function f2(v)      { return (v >= 0 ? '+' : '') + v.toFixed(2) }
function f3(v)      { return v.toFixed(3) }
function bar(v, lo, hi, w = 20) {
  // ASCII bar chart: maps v in [lo,hi] to w chars
  const filled = Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

// ── Dominant regime label ─────────────────────────────────────────────────────

function regime(row) {
  const candidates = [
    { k: 'p_volatile',      l: 'volatile'  },
    { k: 'p_trending_up',   l: 'trend↑'    },
    { k: 'p_trending_down', l: 'trend↓'    },
    { k: 'p_ranging',       l: 'ranging'   }
  ]
  let best = candidates[0]
  for (const c of candidates) if ((row[c.k] || 0) > (row[best.k] || 0)) best = c
  return best.l
}

// ── Section printer ───────────────────────────────────────────────────────────

function section(title) {
  log('')
  log(SEP2)
  log(`  ${title}`)
  log(SEP2)
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv)

  // Open replay DB
  let replayDb
  try { replayDb = new Database(args.src, { readonly: true }) }
  catch (e) { log(`ERROR: cannot open ${args.src} — run replay first`); process.exit(1) }

  // Open ticks DB (optional — for signal breakdown)
  let ticksDb = null
  try { ticksDb = new Database(args.ticks, { readonly: true }) }
  catch { /* silent — signal breakdown section will be skipped */ }

  // Load exits
  let exitQuery = 'SELECT * FROM exits'
  const where = []
  if (args.agent) where.push(`agent_id = '${args.agent}'`)
  if (args.mode)  where.push(`mode = '${args.mode}'`)
  if (where.length) exitQuery += ' WHERE ' + where.join(' AND ')
  exitQuery += ' ORDER BY timestamp ASC'

  const exits = replayDb.prepare(exitQuery).all()

  if (!exits.length) {
    log('No exits found. Check --src path or run replay first.')
    process.exit(0)
  }

  // Load entries (for size_usd, signal values if no ticks DB)
  let entryQuery = 'SELECT * FROM entries'
  if (where.length) entryQuery += ' WHERE ' + where.join(' AND ')
  const entries    = replayDb.prepare(entryQuery).all()
  const entryByKey = {}
  for (const e of entries) entryByKey[`${e.agent_id}:${e.pair}:${e.timestamp}`] = e

  const dateRange = `${new Date(exits[0].timestamp).toISOString().slice(0,10)} → ${new Date(exits[exits.length-1].timestamp).toISOString().slice(0,10)}`

  log('')
  log(SEP2)
  log('  BACKTEST DIAGNOSIS')
  log(`  ${args.src}   ${dateRange}`)
  log(SEP2)

  // ── 1. PER-AGENT SUMMARY ────────────────────────────────────────────────────

  section('1. PER-AGENT SUMMARY')

  const agents = [...new Set(exits.map(e => e.agent_id))].sort()

  log(`${'Agent'.padEnd(7)} ${'Mode'.padEnd(6)} ${'Trades'.padStart(7)} ${'Win%'.padStart(6)} ${'AvgWin'.padStart(8)} ${'AvgLoss'.padStart(8)} ${'Expect'.padStart(8)} ${'AvgHold'.padStart(8)}`)
  log(SEP)

  for (const agentId of agents) {
    const ae   = exits.filter(e => e.agent_id === agentId)
    const mode = ae[0].mode
    const wins = ae.filter(e => e.pnl_pct > 0)
    const loss = ae.filter(e => e.pnl_pct <= 0)
    const avgW = wins.length ? mean(wins.map(e => e.pnl_pct)) : 0
    const avgL = loss.length ? mean(loss.map(e => e.pnl_pct)) : 0
    // Expectancy = win% × avgWin + loss% × avgLoss
    const winR = wins.length / ae.length
    const expect = (winR * avgW + (1 - winR) * avgL).toFixed(3)
    const avgHold = mean(ae.map(e => e.holding_rounds || 0)).toFixed(1)
    log(
      `${agentId.padEnd(7)} ${mode.padEnd(6)} ${String(ae.length).padStart(7)} ` +
      `${pct(wins.length, ae.length).padStart(6)} ` +
      `${(f2(avgW)+'%').padStart(8)} ${(f2(avgL)+'%').padStart(8)} ` +
      `${(expect+'%').padStart(8)} ${(avgHold+'r').padStart(8)}`
    )
  }

  log('')
  log('Expectancy = (win% × avg win) + (loss% × avg loss). Positive = edge exists.')

  // ── 2. EXIT REASON BREAKDOWN ─────────────────────────────────────────────────

  section('2. EXIT REASON BREAKDOWN  (what is killing P&L)')

  const reasons = [...new Set(exits.map(e => e.exit_reason))].sort()
  log(`${'Reason'.padEnd(18)} ${'Count'.padStart(7)} ${'Win%'.padStart(6)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)}`)
  log(SEP)

  for (const r of reasons) {
    const re    = exits.filter(e => e.exit_reason === r)
    const wins  = re.filter(e => e.pnl_pct > 0)
    const total = re.reduce((s, e) => s + e.pnl_pct, 0)
    log(
      `${r.padEnd(18)} ${String(re.length).padStart(7)} ` +
      `${pct(wins.length, re.length).padStart(6)} ` +
      `${(f2(mean(re.map(e => e.pnl_pct)))+'%').padStart(8)} ` +
      `${(f2(total)+'%').padStart(10)}`
    )
  }

  log('')
  log('stop_loss dominating = thresholds too loose or stop too wide')
  log('signal/cvd dominating = entries timed poorly, exits too slow to react')

  // ── 3. ENTRY SCORE BUCKETS ───────────────────────────────────────────────────

  section('3. ENTRY SCORE vs WIN RATE  (does a higher score predict a win?)')

  const buckets = [
    { lo: -Infinity, hi: 0.10, label: '< 0.10 (weak)  ' },
    { lo: 0.10,      hi: 0.15, label: '0.10 – 0.15    ' },
    { lo: 0.15,      hi: 0.20, label: '0.15 – 0.20    ' },
    { lo: 0.20,      hi: 0.25, label: '0.20 – 0.25    ' },
    { lo: 0.25,      hi: 0.30, label: '0.25 – 0.30    ' },
    { lo: 0.30,      hi: Infinity, label: '> 0.30 (strong)' }
  ]

  log(`${'Score bucket'.padEnd(18)} ${'Count'.padStart(7)} ${'Win%'.padStart(6)} ${'AvgPnL'.padStart(8)}   ${'Win rate bar'}`)
  log(SEP)

  for (const b of buckets) {
    const be   = exits.filter(e => (e.entry_score || 0) >= b.lo && (e.entry_score || 0) < b.hi)
    if (!be.length) continue
    const wins = be.filter(e => e.pnl_pct > 0)
    const winR = wins.length / be.length
    const avgP = mean(be.map(e => e.pnl_pct))
    log(
      `${b.label.padEnd(18)} ${String(be.length).padStart(7)} ` +
      `${pct(wins.length, be.length).padStart(6)} ` +
      `${(f2(avgP)+'%').padStart(8)}   ` +
      `${bar(winR, 0, 1, 24)} ${(winR*100).toFixed(0)}%`
    )
  }

  log('')
  log('If win% rises with score: raise entry threshold to filter weak signals.')
  log('If win% is flat across buckets: the composite score has no predictive value.')

  // ── 4. REGIME ANALYSIS ────────────────────────────────────────────────────────

  section('4. REGIME ANALYSIS  (entry-time regime — what condition we entered in)')

  // Build entry lookup: for each exit, find its entry by backing out holding_rounds × 15m
  const CANDLE_MS = 15 * 60 * 1000
  // Also build agent+pair sorted entry list for fallback lookup
  const entriesByAgentPair = {}
  for (const e of entries) {
    const k = `${e.agent_id}:${e.pair}`
    if (!entriesByAgentPair[k]) entriesByAgentPair[k] = []
    entriesByAgentPair[k].push(e)
  }
  for (const arr of Object.values(entriesByAgentPair)) arr.sort((a, b) => a.timestamp - b.timestamp)

  function entryForExit(exit) {
    // Try exact timestamp match first (holding_rounds * 15m)
    const estTs = exit.timestamp - (exit.holding_rounds || 0) * CANDLE_MS
    const exact  = entryByKey[`${exit.agent_id}:${exit.pair}:${estTs}`]
    if (exact) return exact
    // Fallback: last entry before exit timestamp for this agent+pair
    const arr = entriesByAgentPair[`${exit.agent_id}:${exit.pair}`] || []
    let best = null
    for (const en of arr) {
      if (en.timestamp <= exit.timestamp) best = en
      else break
    }
    return best
  }

  const regimes = ['volatile', 'trend↑', 'trend↓', 'ranging']
  log(`${'Regime (entry)'.padEnd(16)} ${'Count'.padStart(7)} ${'Win%'.padStart(6)} ${'AvgPnL'.padStart(8)} ${'AvgHold'.padStart(8)}`)
  log(SEP)

  for (const r of regimes) {
    const re   = exits.filter(e => {
      const entry = entryForExit(e)
      return entry ? regime(entry) === r : false
    })
    if (!re.length) continue
    const wins = re.filter(e => e.pnl_pct > 0)
    const avgP = mean(re.map(e => e.pnl_pct))
    const avgH = mean(re.map(e => e.holding_rounds || 0))
    log(
      `${r.padEnd(16)} ${String(re.length).padStart(7)} ` +
      `${pct(wins.length, re.length).padStart(6)} ` +
      `${(f2(avgP)+'%').padStart(8)} ${(avgH.toFixed(1)+'r').padStart(8)}`
    )
  }

  // Unmatched exits (no entry found)
  const unmatched = exits.filter(e => !entryForExit(e))
  if (unmatched.length) log(`  (${unmatched.length} exits unmatched — entry timestamps may not align)`)

  log('')
  log('If one regime has win% > 50%: the strategy has edge there — restrict entries to that regime.')
  log('If volatile has low win%: add a volatility gate to block entries in volatile conditions.')

  // ── 5. HOLDING TIME ───────────────────────────────────────────────────────────

  section('5. HOLDING TIME  (winners vs losers)')

  const wins = exits.filter(e => e.pnl_pct > 0)
  const loss = exits.filter(e => e.pnl_pct <= 0)

  const wHold = wins.map(e => e.holding_rounds || 0)
  const lHold = loss.map(e => e.holding_rounds || 0)

  log(`             ${'Count'.padStart(7)} ${'AvgHold'.padStart(9)} ${'MedianHold'.padStart(12)} ${'AvgPnL'.padStart(9)}`)
  log(SEP)
  log(`Winners      ${String(wins.length).padStart(7)} ${(mean(wHold).toFixed(1)+'r').padStart(9)} ${(median(wHold).toFixed(1)+'r').padStart(12)} ${(f2(mean(wins.map(e=>e.pnl_pct)))+'%').padStart(9)}`)
  log(`Losers       ${String(loss.length).padStart(7)} ${(mean(lHold).toFixed(1)+'r').padStart(9)} ${(median(lHold).toFixed(1)+'r').padStart(12)} ${(f2(mean(loss.map(e=>e.pnl_pct)))+'%').padStart(9)}`)

  log('')
  if (wHold.length && lHold.length) {
    if (mean(lHold) > mean(wHold) * 1.5) {
      log('  → Losers are held MUCH longer than winners. Classic "let losers run, cut winners early".')
      log('    Fix: tighten stop_loss_pct, or add a max_holding_rounds limit.')
    } else if (mean(wHold) > mean(lHold) * 1.5) {
      log('  → Winners are held longer. Stop losses firing too early on positions that would recover.')
      log('    Fix: widen stop_loss_pct slightly, or increase min_holding_rounds.')
    } else {
      log('  → Hold times similar for wins and losses. Exit timing is not the main problem.')
    }
  }

  // Holding time histogram
  log('')
  log('Hold time distribution (all trades):')
  const holdBuckets = [
    { lo: 0, hi: 2,   label: '1–2r   (< 30m)' },
    { lo: 2, hi: 5,   label: '3–5r   (45m–1h)' },
    { lo: 5, hi: 10,  label: '6–10r  (1.5–2.5h)' },
    { lo: 10, hi: 20, label: '11–20r (2.5–5h)' },
    { lo: 20, hi: Infinity, label: '21r+   (> 5h)' }
  ]
  for (const b of holdBuckets) {
    const be = exits.filter(e => (e.holding_rounds||0) >= b.lo && (e.holding_rounds||0) < b.hi)
    if (!be.length) continue
    const bw = be.filter(e => e.pnl_pct > 0)
    log(`  ${b.label.padEnd(20)} ${String(be.length).padStart(5)} trades   win% ${pct(bw.length, be.length).padStart(6)}`)
  }

  // ── 6. SIGNAL VALUES AT ENTRY ─────────────────────────────────────────────────

  if (ticksDb) {
    section('6. SIGNAL VALUES AT ENTRY  (winners vs losers)')

    const SIGNALS = [
      { key: 'cvd_norm',          label: 'CVD             ' },
      { key: 'funding_signal',    label: 'Funding rate    ' },
      { key: 'momentum_1h',       label: 'Momentum 1h     ' },
      { key: 'momentum_4h',       label: 'Momentum 4h     ' },
      { key: 'rsi_norm',          label: 'RSI             ' },
      { key: 'volume_zscore',     label: 'Volume z-score  ' },
      { key: 'fear_greed_signal', label: 'Fear/Greed      ' },
    ]

    // For each exit, look up the tick at entry time
    const tickStmt = ticksDb.prepare(
      'SELECT * FROM ticks WHERE pair = ? AND timestamp = ? LIMIT 1'
    )

    const winSignals  = Object.fromEntries(SIGNALS.map(s => [s.key, []]))
    const lossSignals = Object.fromEntries(SIGNALS.map(s => [s.key, []]))
    let matched = 0

    for (const ex of exits) {
      // Entry timestamp: look up from entries table
      const entryKey = entries.find(e =>
        e.agent_id === ex.agent_id && e.pair === ex.pair && e.timestamp <= ex.timestamp
      )
      if (!entryKey) continue

      const tick = tickStmt.get(ex.pair, entryKey.timestamp)
      if (!tick) continue
      matched++

      const bucket = ex.pnl_pct > 0 ? winSignals : lossSignals
      for (const s of SIGNALS) {
        if (tick[s.key] != null) bucket[s.key].push(tick[s.key])
      }
    }

    log(`Matched ${matched}/${exits.length} trades to tick data.`)
    log('')
    log(`${'Signal'.padEnd(18)} ${'Win avg'.padStart(9)} ${'Loss avg'.padStart(10)} ${'Δ'.padStart(8)}   ${'Interpretation'}`)
    log(SEP)

    const findings = []

    for (const s of SIGNALS) {
      const wa = mean(winSignals[s.key])
      const la = mean(lossSignals[s.key])
      const delta = wa - la
      const interp = Math.abs(delta) < 0.02 ? '— no difference'
        : delta > 0 ? `↑ winners have higher ${s.key.split('_')[0]}`
        : `↓ losers have higher ${s.key.split('_')[0]}`
      log(
        `${s.label} ${f3(wa).padStart(9)} ${f3(la).padStart(10)} ` +
        `${(delta >= 0 ? '+' : '') + delta.toFixed(3).padStart(8)}   ${interp}`
      )
      if (Math.abs(delta) >= 0.02) findings.push({ key: s.key, label: s.label.trim(), delta, wa, la })
    }

    if (findings.length) {
      log('')
      log('Most predictive signals (biggest difference between winners and losers):')
      findings
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .forEach((f, i) => {
          const dir = f.delta > 0 ? 'positive' : 'negative'
          log(`  ${i+1}. ${f.label}: winners average ${f3(f.wa)}, losers ${f3(f.la)} — higher ${dir} values predict wins`)
        })
    }
  } else {
    log('')
    log('(Signal breakdown skipped — run with --ticks ./data/backtest.db to enable)')
  }

  // ── 7. RECOMMENDATIONS ───────────────────────────────────────────────────────

  section('7. RECOMMENDATIONS')

  // Win rate overall
  const overallWins = exits.filter(e => e.pnl_pct > 0)
  const overallWinR = overallWins.length / exits.length

  if (overallWinR < 0.35) {
    log('  ✖ Win rate below 35% — entries are low quality.')
    log('    → Raise entry thresholds significantly (buy_signal_per_regime)')
    log('    → Consider adding a minimum signal strength gate')
  } else if (overallWinR < 0.50) {
    log('  △ Win rate 35–50% — marginal entries getting through.')
    log('    → Raise entry thresholds moderately')
  } else {
    log('  ✓ Win rate above 50% — entry quality acceptable')
  }

  // Stop loss analysis
  const stopLossExits  = exits.filter(e => e.exit_reason === 'stop_loss' || e.exit_reason === 'stop_loss_intra')
  const stopLossPct    = stopLossExits.length / exits.length
  if (stopLossPct > 0.40) {
    log('')
    log(`  ✖ ${(stopLossPct*100).toFixed(0)}% of trades exit via stop_loss — strategy is entering against the trend.`)
    log('    → Tighten entry gates (CVD, funding)')
    log('    → Or widen stop_loss_pct to give positions more room')
  }

  // Regime with best win rate
  const regimeStats = regimes.map(r => {
    const re = exits.filter(e => regime(e) === r)
    const w  = re.filter(e => e.pnl_pct > 0)
    return { r, winR: re.length ? w.length / re.length : 0, count: re.length }
  }).filter(x => x.count >= 10)

  const bestRegime  = regimeStats.sort((a, b) => b.winR - a.winR)[0]
  const worstRegime = regimeStats[regimeStats.length - 1]

  if (bestRegime && bestRegime.winR > 0.50) {
    log('')
    log(`  ✓ Best regime: ${bestRegime.r} (${(bestRegime.winR*100).toFixed(0)}% win rate)`)
    log(`    → Consider restricting entries to ${bestRegime.r} regime only`)
  }
  if (worstRegime && worstRegime.winR < 0.30) {
    log('')
    log(`  ✖ Worst regime: ${worstRegime.r} (${(worstRegime.winR*100).toFixed(0)}% win rate)`)
    log(`    → Block entries when p_${worstRegime.r.replace('↑','_up').replace('↓','_down')} is dominant`)
  }

  // Score bucket with best win rate
  const scoreBuckets = buckets.map(b => {
    const be = exits.filter(e => (e.entry_score||0) >= b.lo && (e.entry_score||0) < b.hi)
    const w  = be.filter(e => e.pnl_pct > 0)
    return { label: b.label, lo: b.lo, winR: be.length ? w.length/be.length : 0, count: be.length }
  }).filter(x => x.count >= 5)

  const bestBucket = scoreBuckets.sort((a, b) => b.winR - a.winR)[0]
  if (bestBucket && bestBucket.winR > 0.45 && bestBucket.lo > 0.10) {
    log('')
    log(`  ✓ Score bucket "${bestBucket.label.trim()}" has ${(bestBucket.winR*100).toFixed(0)}% win rate`)
    log(`    → Raise entry threshold to ${bestBucket.lo.toFixed(2)} to filter out weaker signals`)
  }

  log('')
  log(SEP)
  log('')

  replayDb.close()
  if (ticksDb) ticksDb.close()
}

main()
