'use strict'

require('dotenv').config()

const fs         = require('fs')
const path       = require('path')
const EventStore  = require('./event-store')
const { ConfigStore } = require('./config-store')

const log = (...args) => process.stdout.write(new Date().toISOString() + ' [ADAPT] ' + args.join(' ') + '\n')

// ── Environment ────────────────────────────────────────────────────────────────

const ADAPT_TRIGGER_N  = parseInt(process.env.ADAPT_TRIGGER_N)  || 5
const ADAPT_COOLDOWN_N = parseInt(process.env.ADAPT_COOLDOWN_N) || 3
const ADAPT_POLL_MS    = parseInt(process.env.ADAPT_POLL_MS)    || 60000
const PAPER_DISCOUNT   = parseFloat(process.env.PAPER_DISCOUNT) || 0.7
const PRIOR_SIGMA      = parseFloat(process.env.PRIOR_SIGMA)    || 1.0
const EXP_DECAY        = parseFloat(process.env.EXP_DECAY)      || 0.9
const RESET_STREAK     = parseInt(process.env.RESET_STREAK)     || 3

// Meta-adapt
const META_SCORE_EXITS = parseInt(process.env.META_SCORE_EXITS) || 20   // recent exits to score each agent
const META_MIN_EXITS   = parseInt(process.env.META_MIN_EXITS)   || 8    // min exits for an agent to be eligible teacher
const META_MIN_DELTA   = parseFloat(process.env.META_MIN_DELTA) || 0.002 // min reward delta to consider promoting
const META_STABILITY   = parseInt(process.env.META_STABILITY)   || 2    // consecutive meta cycles before first promotion
const META_COOLDOWN_N  = parseInt(process.env.META_COOLDOWN_N)  || 3    // meta cycles before same param can be promoted again
const META_EVERY_N     = parseInt(process.env.META_EVERY_N)     || 3    // run meta-adapt every N poll cycles

// ── Parameter space ───────────────────────────────────────────────────────────

const PARAM_SPACE = [
  // Signal weights
  { path: 'weights.cvd_norm',          min: 0.05, max: 0.50, step: 0.02 },
  { path: 'weights.funding_signal',    min: 0.05, max: 0.50, step: 0.02 },
  { path: 'weights.momentum_1h',       min: 0.05, max: 0.40, step: 0.02 },
  { path: 'weights.momentum_4h',       min: 0.00, max: 0.30, step: 0.01 },
  { path: 'weights.rsi_norm',          min: 0.02, max: 0.40, step: 0.02 },
  { path: 'weights.volume_zscore',     min: 0.02, max: 0.40, step: 0.02 },
  { path: 'weights.fear_greed_signal', min: 0.00, max: 0.30, step: 0.02 },
  { path: 'weights.news_signal',       min: 0.00, max: 0.30, step: 0.02 },

  // Entry thresholds — per regime (larger step for faster convergence)
  { path: 'entry.buy_signal_per_regime.volatile',      min: 0.15, max: 0.60, step: 0.05 },
  { path: 'entry.buy_signal_per_regime.trending_up',   min: 0.10, max: 0.50, step: 0.05 },
  { path: 'entry.buy_signal_per_regime.trending_down', min: 0.15, max: 0.55, step: 0.05 },
  { path: 'entry.buy_signal_per_regime.ranging',       min: 0.20, max: 0.60, step: 0.05 },

  // Entry gates (larger step for faster convergence)
  { path: 'entry.cvd_buy_min',         min: -0.10, max: 0.20, step: 0.05 },
  { path: 'entry.funding_buy_max',     min:  0.20, max: 1.00, step: 0.05 },

  // Exit thresholds
  { path: 'exit.sell_signal',                  min: -0.30, max:  0.00, step: 0.02 },
  { path: 'exit.cvd_sell_max',                 min: -0.60, max: -0.05, step: 0.02 },
  { path: 'exit.sell_loss_pct_base',           min:  3.0,  max: 12.0,  step: 0.5  },
  { path: 'exit.sell_loss_pct_trending_down',  min:  2.0,  max:  8.0,  step: 0.5  },
  { path: 'exit.sell_profit_pct',              min:  5.0,  max: 25.0,  step: 1.0  },

  // Sizing
  { path: 'sizing.buy_size_pct_base',  min: 0.05, max: 0.40, step: 0.02 },
  { path: 'sizing.cash_min_pct',       min: 0.10, max: 0.50, step: 0.02 },

  // Hold
  { path: 'hold.deadweight_rounds_min',    min:  3, max: 20, step: 1   },
  { path: 'hold.deadweight_pnl_threshold', min:  1, max:  8, step: 0.5 },

  // Kelly
  { path: 'kelly.kelly_min_trades',     min:  3, max: 15, step: 1    },
  { path: 'kelly.kelly_cap_multiplier', min:  1, max:  4, step: 0.25 },
]

// ── Nested path helpers ────────────────────────────────────────────────────────

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj)
}

function setNestedValue(obj, dotPath, value) {
  const keys = dotPath.split('.')
  const last  = keys.pop()
  const node  = keys.reduce((o, k) => { if (o[k] == null) o[k] = {}; return o[k] }, obj)
  node[last] = value
}

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg))
}

// ── Reward formula ────────────────────────────────────────────────────────────

function computeReward(exits) {
  if (!exits.length) return 0

  let totalW  = 0
  let sumPnlW = 0
  let sumRndW = 0

  for (let i = 0; i < exits.length; i++) {
    const e      = exits[i]
    const age    = exits.length - 1 - i
    const modeW  = e.mode === 'paper' ? PAPER_DISCOUNT : 1.0
    const w      = Math.pow(EXP_DECAY, age) * modeW
    const rounds = Math.max(e.holding_rounds || 1, 1)

    sumPnlW += w * (e.pnl_pct || 0)
    sumRndW += w * rounds
    totalW  += w
  }

  if (totalW === 0 || sumRndW === 0) return 0
  return (sumPnlW / totalW) / (sumRndW / totalW)
}

// ── Gaussian Thompson posterior ───────────────────────────────────────────────

class GaussianPosterior {
  constructor(mu = 0, sigma = PRIOR_SIGMA) {
    this.mu    = mu
    this.sigma = sigma
  }

  update(observedDelta, likelihoodSigma = 1.0) {
    const s2  = this.sigma * this.sigma
    const l2  = likelihoodSigma * likelihoodSigma
    const ns2 = 1 / (1 / s2 + 1 / l2)
    this.mu    = ns2 * (this.mu / s2 + observedDelta / l2)
    this.sigma = Math.sqrt(ns2)
  }

  sample() {
    const u1 = Math.random()
    const u2 = Math.random()
    const z  = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-15))) * Math.cos(2 * Math.PI * u2)
    return this.mu + this.sigma * z
  }

  toJSON()           { return { mu: this.mu, sigma: this.sigma } }
  static fromJSON(o) { return new GaussianPosterior(o.mu, o.sigma) }
}

// ── Adaptation Engine ─────────────────────────────────────────────────────────

class AdaptationEngine {
  constructor({ store, configStore, persistDir = './data/posteriors' }) {
    this.store       = store
    this.configStore = configStore
    this.persistDir  = persistDir

    this.posteriors  = {}
    this.cursors     = {}
    this.prevRewards = {}
    this.streaks     = {}
    this.cooldowns   = {}

    // Meta-adapt state
    this.metaHistory    = {}  // `${liveId}.${paramPath}` → { agentId, value, cycles }
    this.metaCooldowns  = {}  // `${liveId}.${paramPath}` → remaining meta cycles
    this.metaCycleCount = 0

    this._interval = null
    this._loadPersisted()
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(this.persistDir)) fs.mkdirSync(this.persistDir, { recursive: true })
    return path.join(this.persistDir, 'posteriors.json')
  }

  _loadPersisted() {
    const p = this._ensureDir()
    if (!fs.existsSync(p)) return
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))

      for (const [id, params] of Object.entries(raw.posteriors || {})) {
        this.posteriors[id] = {}
        for (const [pp, obj] of Object.entries(params)) {
          this.posteriors[id][pp] = GaussianPosterior.fromJSON(obj)
        }
      }
      this.cursors        = raw.cursors        || {}
      this.prevRewards    = raw.prevRewards    || {}
      this.streaks        = raw.streaks        || {}
      this.cooldowns      = raw.cooldowns      || {}
      this.metaHistory    = raw.metaHistory    || {}
      this.metaCooldowns  = raw.metaCooldowns  || {}
      this.metaCycleCount = raw.metaCycleCount || 0

      log(`posteriors loaded  agents=${Object.keys(this.posteriors).length}`)
    } catch (err) {
      log('posterior load failed:', err.message)
    }
  }

  _savePersisted() {
    const p    = this._ensureDir()
    const snap = {}
    for (const [id, params] of Object.entries(this.posteriors)) {
      snap[id] = {}
      for (const [pp, post] of Object.entries(params)) {
        snap[id][pp] = post.toJSON()
      }
    }
    fs.writeFileSync(p, JSON.stringify({
      posteriors:     snap,
      cursors:        this.cursors,
      prevRewards:    this.prevRewards,
      streaks:        this.streaks,
      cooldowns:      this.cooldowns,
      metaHistory:    this.metaHistory,
      metaCooldowns:  this.metaCooldowns,
      metaCycleCount: this.metaCycleCount
    }, null, 2))
  }

  // ── Per-agent initialisation ──────────────────────────────────────────────────

  _ensureAgent(agentId) {
    if (!this.posteriors[agentId]) {
      this.posteriors[agentId] = {}
      for (const p of PARAM_SPACE) {
        this.posteriors[agentId][p.path] = new GaussianPosterior()
      }
    }
    if (!this.streaks[agentId])   this.streaks[agentId]   = {}
    if (!this.cooldowns[agentId]) this.cooldowns[agentId] = {}
  }

  // ── Effective exit count ──────────────────────────────────────────────────────

  _effectiveCount(exits) {
    return exits.reduce((sum, e) => sum + (e.mode === 'paper' ? PAPER_DISCOUNT : 1.0), 0)
  }

  // ── Score an agent by recent exits (used by meta-adapt) ──────────────────────

  _scoreAgent(agentId) {
    // Get most recent META_SCORE_EXITS, desc, then reverse for computeReward (needs asc)
    const exits = this.store.query('exit', { agent_id: agentId, limit: META_SCORE_EXITS, order: 'desc' })
    if (exits.length < META_MIN_EXITS) return null
    return {
      reward:    computeReward([...exits].reverse()),
      exitCount: exits.length,
      mode:      exits[0].mode
    }
  }

  // ── Per-agent Thompson adapt cycle ───────────────────────────────────────────

  async adaptAgent(agentId) {
    this._ensureAgent(agentId)

    const cursor   = this.cursors[agentId] || { timestamp: 0 }
    const newExits = this.store.query('exit', {
      agent_id: agentId,
      from_ts:  cursor.timestamp,
      limit:    5000,
      order:    'asc'
    })

    const effectiveCount = this._effectiveCount(newExits)
    if (effectiveCount < ADAPT_TRIGGER_N) {
      return { agentId, effectiveExits: parseFloat(effectiveCount.toFixed(1)), skipped: true }
    }

    const prevReward  = this.prevRewards[agentId] ?? 0
    const curReward   = computeReward(newExits)
    const rewardDelta = curReward - prevReward

    log(`cycle  agent=${agentId}  exits=${newExits.length}  eff=${effectiveCount.toFixed(1)}  reward=${curReward.toFixed(4)}  Δ=${rewardDelta.toFixed(4)}`)

    const config  = cloneConfig(this.configStore.getConfig(agentId))
    const changes = []

    for (const param of PARAM_SPACE) {
      const cd = this.cooldowns[agentId][param.path] || 0
      if (cd > 0) {
        this.cooldowns[agentId][param.path] = Math.max(0, cd - effectiveCount)
        continue
      }

      const posterior = this.posteriors[agentId][param.path]
      posterior.update(rewardDelta)

      const sample    = posterior.sample()
      const direction = sample > 0.05 ? +1 : sample < -0.05 ? -1 : 0
      if (direction === 0) continue

      const streak = this.streaks[agentId][param.path] || { direction: 0, count: 0 }
      if (direction === streak.direction) {
        streak.count++
        if (streak.count >= RESET_STREAK) {
          log(`  posterior reset  param=${param.path}  streak=${streak.count}`)
          this.posteriors[agentId][param.path] = new GaussianPosterior()
          this.streaks[agentId][param.path]    = { direction: 0, count: 0 }
          continue
        }
        this.streaks[agentId][param.path] = streak
      } else {
        this.streaks[agentId][param.path] = { direction, count: 1 }
      }

      const currentVal = getNestedValue(config, param.path)
      if (currentVal == null) continue

      const proposed = currentVal + direction * param.step
      const clamped  = Math.max(param.min, Math.min(param.max, proposed))
      const decimals = String(param.step).split('.')[1]?.length ?? 0
      const rounded  = parseFloat(clamped.toFixed(decimals))

      if (Math.abs(rounded - currentVal) < param.step * 0.01) continue

      setNestedValue(config, param.path, rounded)
      this.cooldowns[agentId][param.path] = ADAPT_COOLDOWN_N
      changes.push({ path: param.path, oldVal: currentVal, newVal: rounded })
    }

    if (changes.length) {
      const reason     = `adapt cycle: ${changes.length} param(s) updated`
      const newVersion = this.configStore.setConfig(agentId, config, reason)

      const updateEvents = changes.map(c => ({
        type:           'config_update',
        timestamp:      Date.now(),
        agent_id:       agentId,
        param:          c.path,
        old_value:      c.oldVal,
        new_value:      c.newVal,
        reason,
        triggered_by:   'adaptation-engine',
        config_version: newVersion
      }))
      this.store.appendBatch(updateEvents)

      log(`  config updated  agent=${agentId}  v${newVersion}  changes=${changes.length}`)
      for (const c of changes) log(`    ${c.path}: ${c.oldVal} → ${c.newVal}`)
    }

    if (newExits.length) {
      this.cursors[agentId]     = { timestamp: newExits[newExits.length - 1].timestamp + 1 }
      this.prevRewards[agentId] = curReward
    }

    this._savePersisted()

    return {
      agentId,
      effectiveExits: parseFloat(effectiveCount.toFixed(1)),
      reward:         parseFloat(curReward.toFixed(4)),
      rewardDelta:    parseFloat(rewardDelta.toFixed(4)),
      changes
    }
  }

  // ── Meta-adapt: paper agents as live parameter teachers ───────────────────────
  //
  // For each parameter, scores all agents by recent trade reward.
  // When a paper agent consistently outperforms a live agent on the same
  // parameter axis, the live agent's config is stepped toward that value.
  //
  // Stability guard: the same winner must hold for META_STABILITY consecutive
  // meta cycles before a promotion fires, preventing noise-driven changes.
  // Meta cooldown prevents the same parameter being promoted again immediately.

  async metaAdapt() {
    const allAgents = this.configStore.listAgents()

    // Score all agents
    const scores = {}
    for (const id of allAgents) {
      scores[id] = this._scoreAgent(id)
    }

    // Separate live vs paper based on recent trade mode
    const liveAgents  = allAgents.filter(id => scores[id]?.mode === 'live')
    const paperAgents = allAgents.filter(id => scores[id]?.mode === 'paper' && scores[id] !== null)

    if (!liveAgents.length || !paperAgents.length) return []

    log(`meta-adapt  live=${liveAgents.join(',')}  teachers=${paperAgents.join(',')}`)
    for (const id of [...liveAgents, ...paperAgents]) {
      if (scores[id]) log(`  score  agent=${id}  reward=${scores[id].reward.toFixed(4)}  exits=${scores[id].exitCount}`)
    }

    const allPromotions = []

    for (const liveId of liveAgents) {
      const liveScore = scores[liveId]
      if (!liveScore) continue

      const liveConfig = cloneConfig(this.configStore.getConfig(liveId))
      const changes    = []

      for (const param of PARAM_SPACE) {
        const cdKey = `${liveId}.${param.path}`

        // Decrement meta cooldown
        if ((this.metaCooldowns[cdKey] || 0) > 0) {
          this.metaCooldowns[cdKey]--
          continue
        }

        const liveVal = getNestedValue(liveConfig, param.path)
        if (liveVal == null) continue

        // Find best paper agent for this param — must beat live by META_MIN_DELTA
        // and hold a meaningfully different parameter value
        let bestTeacher = null
        for (const paperId of paperAgents) {
          const paperScore = scores[paperId]
          if (!paperScore) continue
          if (paperScore.reward <= liveScore.reward + META_MIN_DELTA) continue

          const paperVal = getNestedValue(this.configStore.getConfig(paperId), param.path)
          if (paperVal == null) continue
          if (Math.abs(paperVal - liveVal) < param.step * 0.5) continue  // values already close enough

          if (!bestTeacher || paperScore.reward > scores[bestTeacher.id].reward) {
            bestTeacher = { id: paperId, value: paperVal, reward: paperScore.reward }
          }
        }

        const histKey = `${liveId}.${param.path}`

        if (!bestTeacher) {
          // No qualifying teacher — reset stability counter
          delete this.metaHistory[histKey]
          continue
        }

        // Check stability: same teacher + same direction must persist META_STABILITY cycles
        const hist      = this.metaHistory[histKey]
        const direction = bestTeacher.value > liveVal ? +1 : -1

        if (hist && hist.agentId === bestTeacher.id && hist.direction === direction) {
          hist.cycles++
          this.metaHistory[histKey] = hist
        } else {
          // New winner or direction changed — start stability count
          this.metaHistory[histKey] = { agentId: bestTeacher.id, direction, cycles: 1 }
          continue
        }

        if (hist.cycles < META_STABILITY) continue  // not stable yet

        // ── Promote: step live agent config one step toward teacher value ────────
        const proposed = liveVal + direction * param.step
        const clamped  = Math.max(param.min, Math.min(param.max, proposed))
        const decimals = String(param.step).split('.')[1]?.length ?? 0
        const rounded  = parseFloat(clamped.toFixed(decimals))

        if (Math.abs(rounded - liveVal) < param.step * 0.01) continue

        setNestedValue(liveConfig, param.path, rounded)
        this.metaCooldowns[cdKey] = META_COOLDOWN_N

        changes.push({
          path:          param.path,
          oldVal:        liveVal,
          newVal:        rounded,
          teacher:       bestTeacher.id,
          teacherReward: bestTeacher.reward,
          liveReward:    liveScore.reward
        })
      }

      if (changes.length) {
        const teachers   = [...new Set(changes.map(c => c.teacher))].join(',')
        const reason     = `meta-adapt: promoted from ${teachers}`
        const newVersion = this.configStore.setConfig(liveId, liveConfig, reason)

        const updateEvents = changes.map(c => ({
          type:           'config_update',
          timestamp:      Date.now(),
          agent_id:       liveId,
          param:          c.path,
          old_value:      c.oldVal,
          new_value:      c.newVal,
          reason:         `meta-adapt from ${c.teacher} (Δreward=${(c.teacherReward - c.liveReward).toFixed(4)})`,
          triggered_by:   'meta-adapt',
          config_version: newVersion
        }))
        this.store.appendBatch(updateEvents)

        log(`  promoted  agent=${liveId}  v${newVersion}  changes=${changes.length}`)
        for (const c of changes) {
          log(`    ${c.path}: ${c.oldVal} → ${c.newVal}  teacher=${c.teacher}  Δreward=${(c.teacherReward - c.liveReward).toFixed(4)}`)
        }

        allPromotions.push({ liveId, changes })
      }
    }

    this._savePersisted()
    return allPromotions
  }

  // ── Pending exit counts (for TUI display) ────────────────────────────────────

  getPendingCounts() {
    const result = {}
    for (const agentId of this.configStore.listAgents()) {
      const cursor = this.cursors[agentId] || { timestamp: 0 }
      const exits  = this.store.query('exit', { agent_id: agentId, from_ts: cursor.timestamp, limit: 5000, order: 'asc' })
      result[agentId] = { effective: parseFloat(this._effectiveCount(exits).toFixed(1)), trigger: ADAPT_TRIGGER_N }
    }
    return result
  }

  // ── Reset one agent ───────────────────────────────────────────────────────────

  resetAgent(agentId) {
    this._ensureAgent(agentId)
    for (const p of PARAM_SPACE) {
      this.posteriors[agentId][p.path] = new GaussianPosterior()
    }
    this.streaks[agentId]   = {}
    this.cooldowns[agentId] = {}
    delete this.cursors[agentId]
    delete this.prevRewards[agentId]

    // Clear meta state for this agent
    for (const key of Object.keys(this.metaHistory)) {
      if (key.startsWith(`${agentId}.`)) delete this.metaHistory[key]
    }
    for (const key of Object.keys(this.metaCooldowns)) {
      if (key.startsWith(`${agentId}.`)) delete this.metaCooldowns[key]
    }

    this._savePersisted()
    log(`posteriors reset  agent=${agentId}`)
  }

  // ── Poll ──────────────────────────────────────────────────────────────────────

  async poll() {
    this.metaCycleCount++

    const agents  = this.configStore.listAgents()
    const results = []
    for (const agentId of agents) {
      try {
        const result = await this.adaptAgent(agentId)
        if (result) results.push(result)
      } catch (err) {
        log(`error  agent=${agentId}  ${err.message}`)
        results.push({ agentId, error: err.message })
      }
    }

    // Meta-adapt runs every META_EVERY_N poll cycles
    let metaResults = []
    if (this.metaCycleCount % META_EVERY_N === 0) {
      try {
        metaResults = await this.metaAdapt()
      } catch (err) {
        log(`meta-adapt error: ${err.message}`)
      }
    }

    return { results, metaResults }
  }

  start() {
    log(`started  trigger=${ADAPT_TRIGGER_N}  cooldown=${ADAPT_COOLDOWN_N}  poll=${ADAPT_POLL_MS}ms  paper_discount=${PAPER_DISCOUNT}`)
    log(`meta-adapt  every=${META_EVERY_N} cycles  min_exits=${META_MIN_EXITS}  stability=${META_STABILITY}  min_delta=${META_MIN_DELTA}`)
    this.poll()
    this._interval = setInterval(() => this.poll(), ADAPT_POLL_MS)
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null }
    log('stopped')
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { AdaptationEngine, computeReward, GaussianPosterior, PARAM_SPACE }

// Auto-start when run directly
if (require.main === module) {
  const store       = new EventStore(process.env.DB_PATH || './data/events.db')
  const configStore = new ConfigStore(process.env.CONFIGS_DIR || './data/configs')
  const engine      = new AdaptationEngine({
    store,
    configStore,
    persistDir: process.env.POSTERIORS_DIR || './data/posteriors'
  })

  engine.start()

  process.on('SIGINT',  () => { engine.stop(); store.close(); process.exit(0) })
  process.on('SIGTERM', () => { engine.stop(); store.close(); process.exit(0) })
}
