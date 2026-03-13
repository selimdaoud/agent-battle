'use strict'

const { C } = require('./world')

// Volatility tiers — max position size as % of total portfolio
const VOL_TIER = {
  LOW:    { pairs: ['BTCUSDT', 'ETHUSDT', 'LTCUSDT'],                                         maxPct: C.VOL_TIER_LOW_MAX_PCT,  label: 'low-vol'  },
  MEDIUM: { pairs: ['BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'ATOMUSDT'],                maxPct: C.VOL_TIER_MED_MAX_PCT,  label: 'med-vol'  },
  HIGH:   { pairs: ['SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT', 'UNIUSDT', 'NEARUSDT'], maxPct: C.VOL_TIER_HIGH_MAX_PCT, label: 'high-vol' },
}
const PAIR_TIER = {}
for (const [, tier] of Object.entries(VOL_TIER)) {
  for (const p of tier.pairs) PAIR_TIER[p] = tier
}

function buildThreatDirective(ctx) {
  const leader = ctx.rivals.slice().sort((a, b) => b.totalValue - a.totalValue)[0]
  const gap    = leader ? ((leader.totalValue - ctx.totalValue) / ctx.totalValue * 100).toFixed(1) : 0

  const archetypePlaybook = {
    'Momentum Rider': [
      'Switch to the pair with the highest signal_score right now — ride the strongest momentum.',
      'Consolidate into 1-2 high-conviction positions rather than spreading thin.',
      'If your current holdings have negative momentum, SELL them and rotate immediately.'
    ],
    'Contrarian': [
      'Find the most oversold pair (lowest signal_score + RSI < 40) and commit to it.',
      'Avoid any pair your rivals hold — differentiation is your survival bonus.',
      'If you hold pairs that rivals also hold, SELL them and find uncorrelated assets.'
    ],
    'Risk Manager': [
      'Protect cash above all — do NOT buy anything with negative signal_score.',
      'If you have a losing position, SELL it to reduce drawdown immediately.',
      'Focus on the single most stable pair (low volatility, near 50 RSI) if you must buy.'
    ]
  }

  const playbook = archetypePlaybook[ctx.archetype] || []

  return `🔴 THREAT STATUS: YOU ARE THREATENED.
  You are ${gap}% behind the leader. The next cull could eliminate you.
  Your survival score is ${ctx.survivalScore.toFixed(3)} — you must improve it THIS tick.

  SURVIVAL PLAYBOOK FOR ${ctx.archetype.toUpperCase()}:
  ${playbook.map((p, i) => `${i + 1}. ${p}`).join('\n  ')}

  CRITICAL: HOLDing while threatened accelerates elimination. You MUST act differently than your recent pattern.
  The adaptation bonus (+0.15) only applies if you CHANGE your dominant strategy.`
}

function buildPrompt(ctx) {
  const signalLines = ctx.signals.map(s =>
    `  ${s.pair.padEnd(12)} (${(C.LABELS[s.pair] || s.pair)}) score=${s.signal_score.toFixed(2).padStart(6)}` +
    `  RSI=${s.rsi_14.toFixed(0).padStart(3)}` +
    `  mom=${s.momentum_1h.toFixed(2).padStart(6)}` +
    `  fund=${(s.funding_signal ?? 0).toFixed(2).padStart(6)}` +
    `  cvd=${(s.cvd_norm ?? 0).toFixed(2).padStart(6)}` +
    `  regime=${s.regime}`
  ).join('\n')

  const holdingLines = Object.entries(ctx.holdings)
    .filter(([, q]) => q > 0)
    .map(([p, q]) => {
      const entry      = ctx.entryPrices[p]
      const now        = ctx.currentPrices[p]
      const value      = now ? q * now : null
      const pct        = (entry && now) ? (now - entry) / entry * 100 : null
      const portPct    = (value != null && ctx.totalValue > 0) ? (value / ctx.totalValue * 100).toFixed(0) : '?'
      const ticksHeld  = ctx.entryRounds[p] != null ? ctx.round - ctx.entryRounds[p] : '?'
      const tier       = PAIR_TIER[p]
      const pctStr     = pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : 'n/a'
      const flag       = pct != null && pct >= C.TAKE_PROFIT_FLAG_PCT   ? '  ← TAKE PROFIT?'
                       : pct != null && pct <= -C.NEAR_STOP_WARN_PCT   ? '  ← NEAR STOP-LOSS'
                       : ''
      const overweight = tier && Number(portPct) > tier.maxPct ? `  ← OVERWEIGHT (max ${tier.maxPct}%)` : ''
      const valStr     = value != null ? `  now=$${value.toFixed(0)}` : ''
      const entStr     = entry ? `  entry=$${entry.toFixed(entry < 1 ? 4 : 0)}` : ''
      return `  ${(C.LABELS[p] || p).padEnd(12)} ${q.toFixed(6)} units${entStr}${valStr}  unrealized=${pctStr}  alloc=${portPct}%  held=${ticksHeld}r  [${tier?.label || '?'}]${flag}${overweight}`
    })
    .join('\n') || '  (none)'

  const memoryLines = ctx.memory.length === 0
    ? '  No decisions yet.'
    : ctx.memory.map(m =>
        `  Round ${m.round}: ${m.action} ${m.pair} $${m.amount?.toFixed(0) || 0}` +
        ` → ${m.outcome} (signal was ${m.signalScore?.toFixed(2) || 'n/a'})\n` +
        `    Reasoning: "${m.reasoning}"`
      ).join('\n')

  const streakLine = ctx.losingStreak >= 2
    ? `  ⚠ LOSING STREAK: ${ctx.losingStreak} consecutive losses — your current approach is not working, adapt now.`
    : ctx.losingStreak === 1
    ? `  1 recent loss.`
    : `  No current losing streak.`

  const pairPerfLines = ctx.pairPerformance.length === 0
    ? '  Not enough data yet.'
    : ctx.pairPerformance.map(p =>
        `  ${p.pair.padEnd(12)} win rate: ${p.winRate}% (${p.trades} trades)${p.winRate < 40 ? ' ← AVOID' : p.winRate >= 60 ? ' ← STRONG' : ''}`
      ).join('\n')

  const rivalLines = ctx.rivals.map(r =>
    `  ${r.name} [${r.archetype}]: $${r.totalValue.toFixed(0)} (${r.pnlPct}%)` +
    ` survival=${r.survivalScore.toFixed(2)} | holds: ${r.holdings} | recent: ${r.recentActions.join('→') || 'none'}`
  ).join('\n')

  return `You are ${ctx.agentName}, an autonomous AI trading agent. Round ${ctx.round}.

ARCHETYPE: ${ctx.archetype}
CONSTRAINT (enforced by engine — you cannot override):
${ctx.archetypeConstraint}

MARKET SIGNALS:
${signalLines}

YOUR PORTFOLIO:
  Cash:    $${ctx.capital.toFixed(2)}
  Total:   $${ctx.totalValue.toFixed(2)}
  P&L:     ${((ctx.totalValue - 10000) / 100).toFixed(2)}%
  Survival score: ${ctx.survivalScore.toFixed(3)}
  Respawns: ${ctx.respawnCount}
Holdings:
${holdingLines}

YOUR LAST ${ctx.memory.length} DECISIONS:
${memoryLines}

PERFORMANCE INSIGHTS:
${streakLine}
Per-pair win rates (last 20 trades):
${pairPerfLines}

RIVALS:
${rivalLines}

SIGNAL LEGEND:
  score  = composite signal (-1 bearish → +1 bullish)
  fund   = funding rate signal: negative = crowded longs (contrarian sell), positive = crowded shorts (contrarian buy)
  cvd    = cumulative volume delta: positive = net buy flow, negative = net sell flow
  mom    = 1h price momentum z-score
  RSI    = 14-period RSI (>70 overbought, <30 oversold)
  Also shown per-holding: Fear & Greed index is market-wide (${ctx.signals[0]?.fear_greed ?? 'n/a'}/100 — <25 extreme fear, >75 extreme greed)

PORTFOLIO RULES:
  - You can hold UP TO 5 different pairs simultaneously — use this to diversify
  - A BUY does NOT require selling existing holdings — you can accumulate positions
  - Each BUY/SELL acts on ONE pair; plan across ticks to build a multi-position portfolio
  - Spreading across 2-4 uncorrelated pairs reduces risk and improves consistency score
  - Holdings flagged ← TAKE PROFIT? are up ≥${C.TAKE_PROFIT_FLAG_PCT}% — consider selling if signals are weakening
  - Holdings flagged ← NEAR STOP-LOSS are within ${C.STOP_LOSS_PCT * 100 - C.NEAR_STOP_WARN_PCT}% of the ${C.STOP_LOSS_PCT * 100}% auto-stop — decide before the engine forces you out
  - Holdings flagged ← OVERWEIGHT exceed their volatility size limit — reduce or rotate
  - Holdings showing held=N rounds: positions flat for ${C.DEADWEIGHT_ROUNDS}+ rounds are deadweight — rotate capital
POSITION SIZING (by volatility — alloc% shown per holding):
  - [low-vol]  BTC, ETH, LTC       → max ${C.VOL_TIER_LOW_MAX_PCT}% of portfolio per position
  - [med-vol]  BNB, XRP, ADA, LINK, ATOM → max ${C.VOL_TIER_MED_MAX_PCT}% of portfolio per position
  - [high-vol] SOL, DOGE, AVAX, DOT, MATIC, UNI, NEAR → max ${C.VOL_TIER_HIGH_MAX_PCT}% of portfolio per position
  - Never allocate more than your volatility limit — the ← OVERWEIGHT flag will appear when breached

SURVIVAL RULES (automatic, no human input):
  - Cull check every ${ctx.config.cullEvery} rounds: lowest survival score gets threatened
  - ${ctx.config.cullThreshold} consecutive last-place rounds → auto-eliminated
  - Portfolio below $${ctx.config.bankruptcyFloor} → auto-respawn
  - More than ${ctx.config.underperformGap}% below leader → auto-threatened
  - Survival score = 50% P&L + 25% consistency + 15% adaptation + 10% risk
  - ADAPTATION BONUS (+0.15): change your dominant strategy after losses
${ctx.threatened ? buildThreatDirective(ctx) : '🟢 THREAT STATUS: Safe.'}

Respond in plain text only — ${ctx.agentName === 'MEGA'
  ? 'one factual sentence about your current position, cash level, and reasoning.'
  : `one vivid sentence describing your current psychological state and market view as ${ctx.agentName}.`
}`
}

/**
 * synthesize(ctx, openai) → string
 *
 * Periodic LLM call (every SYNTHESIS_EVERY_N_ROUNDS ticks) that returns a
 * single personality sentence. Does NOT make trade decisions.
 * Falls back to a static string on error or if openai is not provided.
 */
async function synthesize(ctx, openai) {
  if (!openai) return ''
  const prompt = buildPrompt(ctx)
  try {
    const userMsg = ctx.agentName === 'MEGA'
      ? 'In one sentence: what positions do you currently hold (or that you hold no positions), how much cash do you have, and why are you positioned this way given current signals and regime?'
      : 'Describe your current state in one sentence.'
    const res = await openai.chat.completions.create({
      model:      'gpt-4o',
      max_tokens: 80,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: userMsg }
      ]
    })
    return res.choices[0].message.content.trim()
  } catch {
    return ''
  }
}

module.exports = { synthesize }
