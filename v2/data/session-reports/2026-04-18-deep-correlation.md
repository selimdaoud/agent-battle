# Deep Correlation & Strategy Analysis
_Generated: 2026-04-18T18:50:57.549Z_

## Analysis

### 1. Agent Correlation
- **Overlap**: A1 and A2 have an 82.5% entry overlap and nearly identical exit patterns. They are essentially running the same strategy with minimal diversification.
- **Portfolio Benefit**: The primary difference is A2's slightly more selective entry criteria (higher minimum entry score). However, the high correlation suggests they are doubling risk rather than providing diversification benefits.

### 2. Strategy Quality
- **Trend-Follow Entries**: A1 and A2 entered 12 and 9 trades, respectively, during "no_trend" regimes, all of which were losing on average. Given the macro environment was mostly ranging, these entries were inappropriate and detrimental to performance.

### 3. A3 vs A1/A2
- **Suitability**: A3's strategy, focusing on accumulation during ranging periods, is better suited to the observed macro environment. A3's higher average PnL per trade (+0.406%) compared to A1 (+0.075%) and A2 (+0.227%) reflects this alignment.

### 4. Missed Opportunities
- **Trend Days**: On Apr 6 and Apr 14, both strong trend days, A1 and A2 captured some gains (e.g., LINKUSDT +3.783%, BTCUSDT +2.933% on Apr 14). However, the system did not fully capitalize on these opportunities, likely due to the high correlation and similar trade execution.

### 5. Could They Have Done Better?
- **Strategy Adjustments**:
  - **Regime Sensitivity**: Implement stricter entry criteria to avoid trades during "no_trend" regimes.
  - **Diversification**: Develop distinct strategies for A1 and A2 to reduce correlation and enhance portfolio diversification.
  - **Adaptive Strategy**: Incorporate more dynamic strategies that can switch between trend-following and range-bound tactics based on macro signals.

### 6. Config Evolution
- **Improvement**: The improvement from v0 to v1005 (A1) and v0 to v36 (A2) suggests genuine learning and adaptation to the environment. The later versions show better performance, indicating that the agents have adjusted to the market conditions effectively.

## Recommendations
1. **Reduce Correlation**: Differentiate A1 and A2 strategies to provide genuine diversification.
2. **Enhance Regime Detection**: Improve regime detection to avoid entering trades during unfavorable conditions.
3. **Leverage A3's Strategy**: Consider integrating A3's accumulation strategy into A1 and A2 during ranging periods.
4. **Optimize Configurations**: Continue refining configurations based on performance data to ensure adaptability to changing market conditions.