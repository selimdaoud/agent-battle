'use strict'

require('dotenv').config()
const EventEmitter = require('events')
const OpenAI       = require('openai')
const World        = require('./core/world')
const { C }        = require('./core/world')
const signals      = require('./core/signals')
const strategy     = require('./core/strategy')
const { synthesize } = require('./core/agent')

// ── Market price fetcher ───────────────────────────────────────────────────────
async function fetchPrices(world) {
  try {
    const url  = `https://api.binance.com/api/v3/ticker/price?symbols=${
      encodeURIComponent(JSON.stringify(C.PAIRS))}`
    const data = await fetch(url).then(r => r.json())
    const map  = {}
    data.forEach(item => { map[item.symbol] = parseFloat(item.price) })
    return map
  } catch {
    const snap = world.getSnapshot()
    const last = snap.priceHistory
    const map  = {}
    C.PAIRS.forEach(p => {
      const history = last[p] || []
      const prev    = history[history.length - 1] || 1
      map[p] = prev * (1 + (Math.random() - 0.5) * 0.003)
    })
    return map
  }
}

// ── Core tick ─────────────────────────────────────────────────────────────────
async function tick(world, openai, emitter) {
  const prices  = await fetchPrices(world)
  world.updatePrices(prices)

  const history = world.getPriceHistory()
  const sigs    = await signals.computeSignals(prices, history)

  const alive   = Object.values(world.getSnapshot().agents).filter(a => a.alive)
  const ctxs    = alive.map(a => world.getPromptContext(a.name, sigs, prices))

  // Deterministic strategy decisions — no LLM involved
  const decisions = ctxs.map(ctx => strategy.decide(ctx))

  // Periodic LLM synthesis: update personality every N rounds (not every tick)
  const round = world.getSnapshot().round
  if (round % C.STRATEGY.SYNTHESIS_EVERY_N_ROUNDS === 0) {
    await Promise.all(ctxs.map(async (ctx, i) => {
      decisions[i].personality = await synthesize(ctx, openai)
    }))
  }

  decisions.forEach((d, i) => {
    const result = world.applyDecision(alive[i].name, d, prices)
    emitter.emit('trade', { ...result, agent: alive[i].name })
  })

  world.endTick(sigs)

  const snap = world.getSnapshot()
  emitter.emit('tick', snap)

  const stillAlive = Object.values(snap.agents).filter(a => a.alive)
  if (stillAlive.length === 1) {
    emitter.emit('winner', stillAlive[0].name)
    stop()
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
const world   = new World('./data/sim.db')
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const emitter = new EventEmitter()

let timer      = null
let busy       = false
let interval   = parseInt(process.env.TICK_INTERVAL_MS) || 60000
let lastTickAt = null

function start() {
  if (timer) return
  world._snapshot.running = true
  runTick()
  timer = setInterval(runTick, interval)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  world._snapshot.running = false
}

function setInterval_(ms) {
  interval = ms
  if (timer) { stop(); start() }
}

async function runTick() {
  if (busy) return
  busy = true
  lastTickAt = Date.now()
  try {
    await tick(world, openai, emitter)
  } catch (err) {
    emitter.emit('error', err.message)
  }
  busy = false
}

module.exports = { world, emitter, start, stop, setInterval_, runTick, getIntervalMs: () => interval, getLastTickAt: () => lastTickAt }
