# Agent Learnings

Observations, findings, and decisions accumulated during live operation. Updated as the system runs.

---

## 2026-03-28

### Correlation analysis — A1, A2, A4 act as one agent

Measured pairwise return correlation across ~235 ticks:

| Pair | r |
|---|---|
| A1 ↔ A4 | 0.977 |
| A1 ↔ A2 | 0.817 |
| A2 ↔ A4 | 0.840 |
| A5 ↔ A6 | 0.479 |
| A3 ↔ anything | < 0.31 |

A1 and A4 share 94–100% of their exit timestamps. A1/A2/A4 enter and exit the same pairs at the same tick on the majority of trades. Root cause: all three run `trend_follow_mode` with identical TF gate thresholds. Same tick stream + same gates = same decisions.

**Consequence:** Running all three provides 3× the capital exposure but ~1× the diversification. When MATIC grinds to deadweight, all three eat it simultaneously.

**Action taken:** A4 repositioned as scalper variant (see below).

---

### A4 repositioned as scalper variant (v12, 2026-03-28)

**Problem:** A4 was a near-duplicate of A1 (r=0.977). Its paper trades could not teach A1/A2 anything the live agents hadn't already seen.

**Root cause of the duplication:** All PARAM_SPACE parameters were in the same region as A1. Since both use identical TF gate thresholds, they enter and exit at the same moments regardless of config differences elsewhere.

**Why standard mode was rejected:** Switching A4 to standard mode would explore different territory, but meta-adapt promotions from standard-mode A4 to TF-mode A1/A2 are partially incoherent — 11 of 26 PARAM_SPACE parameters have no effect in TF mode (see PARAM_SPACE gap below). The learned values could not be taught cleanly.

**Solution:** Keep A4 in TF mode (same entry gates as A1/A2), but push its PARAM_SPACE parameters into a radically different region — a fast-exit, high-Kelly scalper profile:

| Parameter | A1 (v11) | A4 (v12) |
|---|---|---|
| `sell_profit_pct` | 13% | **10%** |
| `sell_loss_pct_base` | 6% | **3%** |
| `sell_loss_pct_trending_down` | 3% | **2%** |
| `deadweight_rounds_min` | 17 | **10** |
| `deadweight_pnl_threshold` | 1.0 | **1.5** |
| `kelly_min_trades` | 15 | **5** |
| `kelly_cap_multiplier` | 1.75 | **2.5** |
| `cvd_norm` weight | 0.14 | **0.22** |
| `funding_signal` weight | 0.16 | **0.10** |
| `momentum_1h` weight | 0.12 | **0.20** |
| `fear_greed_signal` weight | 0.10 | **0.02** |

A4 now enters the same setups as A1/A2 (identical TF gates) but exits faster and sizes up earlier when win rate is proven. If A4 outperforms, meta-adapt can promote the specific exit/sizing values to A1/A2 with clean causal attribution.

---

### PARAM_SPACE gap — TF mode agents

The adaptation engine's 26-parameter PARAM_SPACE was designed for standard-mode agents. For `trend_follow_mode` agents, 11 parameters are never evaluated at runtime:

```
Unused in TF mode:
  entry.buy_signal_per_regime.*  (4)  — TF bypasses composite score
  entry.cvd_buy_min                   — TF uses cvd_1c gate instead
  entry.funding_buy_max               — TF has no funding gate
  exit.sell_signal                    — TF uses macro_exit not signal exit
  exit.cvd_sell_max                   — same reason
```

Effect: adaptation cycles tune these 11 parameters but any correlation with reward is spurious. Meta-adapt promotions of these values to TF agents do nothing.

The parameters that actually drive TF agent behaviour — `trend_follow_macro_min`, `trend_follow_ranging_max`, `trend_follow_regime_min`, `trend_follow_mom1h_min`, `trend_follow_cvd1c_max`, `trend_follow_macro_exit` — are not in PARAM_SPACE and therefore cannot be adapted.

**Known gap. Not yet fixed.** The correct fix is to add TF-specific gate parameters to PARAM_SPACE. This requires a code change to `core/adaptation-engine.js`.

---

### A3 promoted to live (2026-03-28)

**Problem:** A3 runs `spot_accum_mode` — it accumulates BTC positions over multiple days as the macro recovers from capitulation. Paper agents reset to zero capital on every engine restart, destroying accumulated positions.

**Action:** `LIVE_AGENTS=2 → 3`, `PAPER_AGENTS=4 → 3` in `.env`. A3 is now live and its state persists across restarts.

**Note:** A3 is decorrelated from the TF cluster (r < 0.31 with all others). It does not compete for the same entry signals and provides genuine diversification.

---

### macro_exit dominates all exit reasons (2026-03-27/28)

Over the 12-hour window observed (21:50 Mar 27 → 09:50 Mar 28), **100% of exits were `macro_exit`** — the 4h macro signal (`macro_p_trending_up`) oscillating around the 0.45 threshold. No stop-losses, no take-profits, no deadweight.

This produced rapid entry/exit cycles (8 rounds ≈ 2h), generating small wins (+0.78% DOT) and small losses (-0.19% AVAX). The macro signal was the dominant driver of all P&L, not entry selection.

**Observation:** When macro oscillates near the threshold, agents churn — entering on the uptick, exiting on the downtick. The adaptation engine sees this as a sequence of low-reward trades and will eventually raise entry thresholds or tighten the macro filter. Whether this is the right response depends on whether the oscillation is temporary noise or a genuine regime shift.

---

### A3 spot_accum entry logic — how the 09:50 entry triggered

A3 entered BTC at 09:50 on 2026-03-28 (@66,550). Reconstruction from rejected events:

| Time | Gate blocked | Meaning |
|---|---|---|
| 08:20–08:50 | `sa_macro_was_low` | 4h macro had never dropped below 0.20 — no capitulation seen, no recovery to buy |
| ~09:00 | — | Macro briefly dipped below 0.20 → `spotAccumMacroWasLow` flipped to `true` |
| 09:05–09:35 | `sa_macro_min` | Macro recovering but still below 0.30 floor |
| 09:50 | **Entry** | Macro crossed 0.30 **and** was rising tick-over-tick |

The 15m regime at entry was 97% ranging — irrelevant to A3. It operates entirely on the 4h macro signal, ignoring short-term noise.

---

### Config hot-reload limitation on macOS

`fs.watch` filters `rename` events. Atomic file writes (write-to-temp + rename) — used by most editors and the `Write` tool — do not trigger the hot-reload watcher.

**Workaround:** Use `POST /config/:id` to push config changes to the running engine. The file on disk is updated automatically by this endpoint and the in-memory config is updated immediately.

```bash
curl -X POST http://localhost:3002/config/A4 \
  -H "Content-Type: application/json" \
  -d "$(cat v2/data/configs/agent-A4.json)"
```
