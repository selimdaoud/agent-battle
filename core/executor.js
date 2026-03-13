'use strict'

/**
 * core/executor.js — Real Binance order execution for MEGA agent
 *
 * Activated only when REAL_TRADING=1 in .env (default: 0 / off), or toggled at
 * runtime via setRealTrading(true/false) — keys O/M in the TUI.
 * All orders are market orders. BUY uses quoteOrderQty (spend X USDT).
 * SELL liquidates the full real balance for that asset.
 *
 * Safety controls:
 *   REAL_TRADING_MAX_ORDER_USD   — hard cap per single order (default $50)
 *   REAL_TRADING_DAILY_LOSS_PCT  — halt all orders if account drops this % today (default 5%)
 */

const VERSION = '1.0.4'

require('dotenv').config()
const crypto = require('crypto')
const https  = require('https')

let _realTrading           = process.env.REAL_TRADING              === '1'
const API_KEY              = process.env.BINANCE_API_KEY            || ''
const API_SECRET           = process.env.BINANCE_API_SECRET         || ''
const MAX_ORDER_USD        = parseFloat(process.env.REAL_TRADING_MAX_ORDER_USD)   || 50
const DAILY_LOSS_LIMIT_PCT = parseFloat(process.env.REAL_TRADING_DAILY_LOSS_PCT)  || 0.05

// Decimal precision for quantity (SELL orders) per asset
const QTY_PRECISION = {
  BTC: 5, ETH: 4, BNB: 3, SOL: 2, XRP: 0,
  DOGE: 0, ADA: 0, AVAX: 2, DOT: 2, MATIC: 0,
  LINK: 2, LTC: 3, UNI: 2, ATOM: 2, NEAR: 2
}

const log = (...args) => console.log(new Date().toISOString(), '[EXECUTOR]', ...args)

// ── Daily loss tracking ───────────────────────────────────────────────────────
let _startOfDayValue = null
let _dailyHalted     = false
let _lastDayStr      = new Date().toDateString()

// ── Cumulative real fees paid on Binance (USD equivalent) ────────────────────
let _megaRealFees = 0

function _resetDayIfNeeded() {
  const today = new Date().toDateString()
  if (today !== _lastDayStr) {
    _startOfDayValue = null
    _dailyHalted     = false
    _lastDayStr      = today
    log('Daily loss counter reset for new day')
  }
}

// ── Binance signed request ────────────────────────────────────────────────────
function _sign(params) {
  const query = new URLSearchParams(params).toString()
  const sig   = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex')
  return query + '&signature=' + sig
}

function _request(method, path, params = {}) {
  params.timestamp  = Date.now()
  params.recvWindow = 5000
  const signed = _sign(params)
  const body   = method === 'POST' ? signed : ''
  const reqPath = method === 'GET' ? path + '?' + signed : path + '?' + new URLSearchParams({ timestamp: params.timestamp, recvWindow: params.recvWindow }).toString() + '&signature=' + _sign(params)

  // For POST, send params in body
  const postPath = path
  const getPath  = path + '?' + signed

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.binance.com',
      path:     method === 'GET' ? getPath : postPath,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        ...(method === 'POST' ? {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON from Binance: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (method === 'POST' && body) req.write(body)
    req.end()
  })
}

// ── Account balance ───────────────────────────────────────────────────────────
async function getAccountBalance() {
  const account = await _request('GET', '/api/v3/account', {})
  if (account.code) throw new Error(`Binance error ${account.code}: ${account.msg}`)
  const balances = {}
  for (const b of (account.balances || [])) {
    const free = parseFloat(b.free)
    if (free > 0.000001) balances[b.asset] = free
  }
  return balances
}

// ── Order execution ───────────────────────────────────────────────────────────
async function execute(decision, prices) {
  if (!_realTrading) return null

  if (!API_KEY || !API_SECRET) {
    log('ERROR: BINANCE_API_KEY / BINANCE_API_SECRET not set — cannot execute')
    return null
  }

  if (decision.action === 'HOLD') {
    log(`HOLD — no order placed${decision.pair ? ' (' + decision.pair + ')' : ''}`)
    return null
  }

  _resetDayIfNeeded()

  if (_dailyHalted) {
    log('HALTED — daily loss limit reached, skipping order')
    return null
  }

  const { action, pair, amount_usd } = decision
  const price = prices[pair]
  if (!price) { log(`No price available for ${pair} — skipping`); return null }

  try {
    let order

    if (action === 'BUY') {
      const usd = Math.min(amount_usd || MAX_ORDER_USD, MAX_ORDER_USD)
      if (usd < 10) { log(`BUY ${pair}: $${usd.toFixed(2)} below $10 minimum — skipping`); return null }
      log(`→ BUY  ${pair}  $${usd.toFixed(2)} USDT (market quoteOrderQty)`)
      order = await _request('POST', '/api/v3/order', {
        symbol:        pair,
        side:          'BUY',
        type:          'MARKET',
        quoteOrderQty: usd.toFixed(2)
      })

    } else if (action === 'SELL') {
      const balances = await getAccountBalance()
      const asset    = pair.replace('USDT', '')
      const rawQty   = balances[asset] || 0
      if (rawQty <= 0) { log(`SELL ${pair}: no ${asset} balance — skipping`); return null }
      const precision = QTY_PRECISION[asset] ?? 4
      const qty       = (Math.floor(rawQty * Math.pow(10, precision)) / Math.pow(10, precision)).toFixed(precision)
      if (parseFloat(qty) <= 0) { log(`SELL ${pair}: qty rounds to 0 — skipping`); return null }
      log(`→ SELL ${pair}  qty=${qty} ${asset} (market, full position)`)
      order = await _request('POST', '/api/v3/order', {
        symbol:   pair,
        side:     'SELL',
        type:     'MARKET',
        quantity: qty
      })
    }

    if (!order) return null

    if (order.orderId) {
      const executedQty = parseFloat(order.executedQty        || 0)
      const quoteQty    = parseFloat(order.cummulativeQuoteQty || 0)
      const fillPrice   = executedQty > 0 ? quoteQty / executedQty : 0

      // Sum real fees across all fills, converting to USD equivalent
      let feeUsd = 0
      for (const fill of (order.fills || [])) {
        const commission = parseFloat(fill.commission || 0)
        const asset      = fill.commissionAsset
        if (asset === 'USDT')                  feeUsd += commission
        else if (asset === pair.replace('USDT', '')) feeUsd += commission * fillPrice
        else                                   feeUsd += commission * (prices[asset + 'USDT'] || 0)
      }
      _megaRealFees += feeUsd

      log(`✓ OK  orderId=${order.orderId}  ${action} ${pair}  qty=${executedQty.toFixed(5)}  fill=$${fillPrice.toFixed(4)}  value=$${quoteQty.toFixed(2)}  fee=$${feeUsd.toFixed(4)} USD  status=${order.status}`)
      return { order, fillPrice, feeUsd }
    } else {
      log(`✗ ERROR placing ${action} ${pair}: code=${order.code} msg=${order.msg}`)
      return null
    }

  } catch (err) {
    log(`✗ EXCEPTION: ${err.message}`)
    return null
  }
}

// ── Sync MEGA sim state from real Binance account ─────────────────────────────
// Called once per tick before context is built, so strategy decisions use real capital/holdings.
// Only capital and holdings are synced; survival score, entryPrices etc. remain as-is.
async function syncMegaState(world, prices) {
  if (!_realTrading) return
  try {
    const balances = await getAccountBalance()
    // Access live snapshot directly — getSnapshot() returns a deep copy
    const mega = world._snapshot.agents['MEGA']
    if (!mega) return

    // Sync USDT cash
    mega.capital = balances['USDT'] || 0

    // Sync holdings — only assets that map to a tracked pair
    const newHoldings = {}
    for (const [asset, qty] of Object.entries(balances)) {
      if (asset === 'USDT') continue
      const pair = asset + 'USDT'
      if (prices[pair] && qty > 0.000001) newHoldings[pair] = qty
    }
    mega.holdings = newHoldings

    // Sync real cumulative fees (replaces sim fee estimates)
    mega.totalFees = _megaRealFees

    const holdStr = Object.keys(newHoldings).join(', ') || 'none'
    log(`Synced MEGA state: USDT=$${mega.capital.toFixed(2)}  holdings=${holdStr}  realFees=$${_megaRealFees.toFixed(4)}`)
  } catch (err) {
    log(`syncMegaState failed: ${err.message}`)
  }
}

// ── Daily loss guard — call after each MEGA tick with current total value ─────
function checkDailyLoss(totalValue) {
  if (!_realTrading || totalValue == null) return false
  _resetDayIfNeeded()
  if (_startOfDayValue === null) {
    _startOfDayValue = totalValue
    log(`Daily loss tracker initialised — start of day value: $${totalValue.toFixed(2)}`)
    return false
  }
  const lossPct = (_startOfDayValue - totalValue) / _startOfDayValue
  const gainPct = -lossPct
  log(`Daily P&L check: $${totalValue.toFixed(2)}  ${gainPct >= 0 ? '+' : ''}${(gainPct * 100).toFixed(2)}%  limit: -${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}%${_dailyHalted ? '  [HALTED]' : ''}`)
  if (lossPct >= DAILY_LOSS_LIMIT_PCT && !_dailyHalted) {
    _dailyHalted = true
    log(`⛔ DAILY LOSS LIMIT: ${(lossPct * 100).toFixed(2)}% ≥ ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% — all real orders halted for today`)
  }
  return _dailyHalted
}

if (_realTrading) {
  log(`REAL TRADING ENABLED — max order: $${MAX_ORDER_USD}  daily loss limit: ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}%`)
} else {
  log('Real trading disabled (REAL_TRADING != 1) — running in simulation mode')
}

function setRealTrading(v) {
  _realTrading = Boolean(v)
  module.exports.REAL_TRADING = _realTrading
  log(_realTrading
    ? `REAL TRADING ENABLED at runtime — max order: $${MAX_ORDER_USD}  daily loss limit: ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}%`
    : 'Real trading DISABLED at runtime — MEGA back to simulation mode')
}

module.exports = { execute, getAccountBalance, syncMegaState, checkDailyLoss, setRealTrading, REAL_TRADING: _realTrading, VERSION }
