# Codex Prompt 1 of 3 — Dashboard CONTEXTUAL

Establishes project context, data sources, trader profile. Send this first
to a fresh Codex session before the analysis or automation prompts. Codex
should ingest the context, ask any clarifying questions, then wait for the
analysis prompt.

---

# Copy-paste below

```
You are about to build a local web dashboard that displays MNQ futures 
trading prep information in a user-friendly way, with probabilities that 
update every 15 minutes based on price movement. You will receive three 
prompts: this contextual one, then the analysis prompt (what to compute), 
then the automation prompt (how to schedule).

For this contextual prompt: READ AND INTERNALIZE. Do not start coding 
until you receive the analysis prompt. Ask clarifying questions if 
anything is ambiguous after reading the full context.

# Project context

The dashboard sits on top of an existing analytics layer at:
`D:\Quant-futures-app\tools\rithmic_analytics\`

The analytics layer (~36 tickets shipped over 3 weeks) processes Rithmic 
captures of MNQ futures into structured zone JSONs, absorption events, 
order pressure series, and other derived signals. Read these to understand 
what data is available:

1. `docs/architecture.md` — system overview + decision log D-001 through D-010
2. `docs/feature_reference.md` — module-by-module API
3. `docs/operations.md` — daily workflow
4. `C:\Users\Neel\.claude\projects\D--MNQ-Futures\memory\project_rithmic_analytics_pipeline.md` 
   — current pipeline state summary

The dashboard is a NEW project (not part of rithmic_analytics). Codex's 
architectural choice: either create it as a sibling project at 
`D:\Quant-futures-app\tools\rithmic_dashboard\` OR add it as a submodule 
inside rithmic_analytics's existing structure (e.g., 
`rithmic_analytics/viewer/dashboard.py` + templates). Follow the existing 
repo conventions; pick whichever is cleaner.

# Trader profile

- **Operator**: Neel. Discretionary intraday MNQ futures trader on a $50K 
  Lucid Trading funded LFF prop account.
- **Style**: Multi-TF volume profile + orderflow-based decisions. NOT an 
  algo trader; uses signals to inform manual entries/exits.
- **Trading rules** that affect what the dashboard should show:
  - Rule 1: HIRO override (his proprietary momentum indicator can override 
    entries)
  - Rule 3: Signal hierarchy SUPER > HIGH > MED > LOW conviction; size 
    accordingly
  - Rule 4: Don't raise PT after taking
  - Rule 5: 2-3 MNQ minimum runners
  - Rule 7: Post-regret window discipline (don't rebuy at worse price 
    after cancelling)
- **Sessions**: Trades both RTH (06:30-13:00 PT) and Globex (overnight, 
  starts 14:55 PT).
- **Hardware**: Single workstation. No GPU. ~1.7TB free disk.

# Daily data artifacts produced

The rithmic_analytics pipeline runs daily (Codex operator manages capture 
+ scheduled daily_zones). Per session, these artifacts land on disk:

| File | Contents | Update frequency |
|---|---|---|
| `data/captures/<date>/MNQ_<session>.jsonl` | Raw probe capture | live during session |
| `data/captures/<date>/MNQ_<session>.obs01.jsonl` | Normalized trades (RA-041 quality) | post-session |
| `data/captures/<date>/MNQ_<session>.mbp1.jsonl` | Top-of-book quotes | post-session |
| `data/captures/<date>/MNQ_<session>.mbo.jsonl` | Order lifecycle events | post-session |
| `data/zones/<date>_MNQ_<session>.json` | VP zones + VWAP/σ ReferenceLines + ATR | once per session, post-close |
| `data/absorption/<date>_MNQ_<session>.json` | Absorption events with 4-factor scores | once per session |
| `data/order_pressure/<date>_MNQ_<session>.json` | MBO add/cancel/spoof per price bin | once per session |
| `data/cancellations/<date>_MNQ_<session>.json` | Tradesea cancellation pattern analysis | once per session (if Tradesea CSV exported) |
| `data/probability_cards/<date>_MNQ_<session>.md` | Conviction-tier probability annotations | once per session |

The dashboard's primary input is `data/zones/<date>_MNQ_<session>.json`. 
Example shape (read this exact file for canonical structure):

```json
{
  "schema_version": 1,
  "symbol": "MNQ",
  "timeframe": "rth",
  "vpoc": 29237.5,
  "vah": 29425.0,
  "val": 29162.5,
  "atr_14": 40.33,
  "bin_size_ticks": 10,
  "zones": [{ "id": "hvn-29237.5", "top": 29240.0, "bot": 29237.5, "type": "support", "conviction": "MED", "text": "HVN 1.8%", "sources": ["hvn_rth"], "volume_pct": 0.0178, ... }, ...],
  "reference_lines": [
    {"price": 29237.5, "text": "VPOC 29237.5", "source": "vpoc"},
    {"price": 29425.0, "text": "VAH 29425", "source": "vah"},
    {"price": 29162.5, "text": "VAL 29162.5", "source": "val"},
    {"price": 29337.25, "text": "VWAP RTH 29337.25", "source": "vwap_rth"},
    {"price": 29441.80, "text": "VWAP RTH +1σ", "source": "vwap_rth_band_p1sd"},
    {"price": 29232.71, "text": "VWAP RTH -1σ", "source": "vwap_rth_band_m1sd"},
    ...
  ]
}
```

# Current "live price" data source

The dashboard needs to know the current MNQ price every 15 minutes. 
Codex's tools do NOT include the TradingView MCP — that's Claude-Code-only.

## Critical operational constraint: I/O cadence

The live raw capture file `data/captures/<date>/MNQ_<session>.jsonl` is 
**multi-GB and actively being written by the probe** during a session 
(typical Globex session reaches 4-5 GB; RTH 2-3 GB). The dashboard must 
NOT read this file in full on every 15-min invocation. That would be 
wasteful (~60 GB/day of redundant disk I/O) and could contend with the 
capture operator's monitoring schedule.

**Data-source preference order** (use the cheapest available):

1. **Normalized siblings** (`.obs01.jsonl` / `.mbp1.jsonl` / `.mbo.jsonl`) — 
   ~5-10% the size of raw. Available POST-SESSION-CLOSE. Use these when 
   they exist + are not stale (mtime < 6 hours).
2. **Pre-computed artifacts** — `data/zones/<date>_MNQ_<session>.json`, 
   `data/order_pressure/<date>_MNQ_<session>.json`, etc. Small JSON files; 
   fast load.
3. **Bounded-tail read of raw JSONL** — ONLY for "current price" during an 
   active session, and ONLY the last ~10-50 KB of the file. Tail reads 
   touch the OS page cache for the file's tail; minimal cost. NEVER 
   full-file scan.
4. **Cheap metadata** — file mtime + size for staleness checks. Use 
   `Path.stat()`; do not open the file.

**During active session** (raw capture file growing):
- Use bounded tail-read for current price (the 10KB pattern below)
- Use cheap metadata (file mtime) for staleness checks
- Don't try to compute fresh VP / pressure / etc. from the raw — those 
  are post-session-close jobs the operator handles

**Between sessions** (normalized siblings exist):
- Use normalized siblings for any richer reads
- Cache derived data in `data/dashboard/` to avoid re-parsing siblings on 
  every 15-min run

Example Python pattern for **bounded-tail current price** (acceptable 
during active session):

```python
import json
from pathlib import Path
from typing import Optional

def get_current_price(capture_file: Path, tail_bytes: int = 20000) -> Optional[float]:
    """Read last LAST_TRADE price via bounded-tail read. O(1) regardless of file size."""
    if not capture_file.exists():
        return None
    size = capture_file.stat().st_size
    seek_pos = max(0, size - tail_bytes)
    with capture_file.open('rb') as f:
        f.seek(seek_pos)
        chunk = f.read().decode('utf-8', errors='ignore')
    # Parse lines from chunk; track latest LAST_TRADE with price
    last_price = None
    for line in chunk.split('\n'):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get('stream') == 'LAST_TRADE' and 'price' in r:
            last_price = r['price']
    return last_price
```

**Tail-bytes rationale**: 20 KB typically contains hundreds of records 
across all streams. LAST_TRADE records are ~3-5% of the stream mix, so 
20 KB ≈ 10-20 LAST_TRADE records — always enough to find a recent print. 
If `last_price is None` after a 20KB tail, bump to 100 KB; if still None, 
log a "no price found in tail" warning and use the last known cached 
price.

## Per-cycle dashboard I/O budget

A single 15-min dashboard generation should:
- Stat ~5-10 files (negligible)
- Tail-read ~20-100 KB of raw capture (negligible)
- Full-read 1-3 small JSON artifacts (~50 KB-1 MB total)
- Write 1 HTML file (~20-50 KB) + 1-3 small state JSON files
- **Total disk I/O per run: < 5 MB** — even on a slow disk, that's <1 second

If you find yourself wanting to read the raw `.jsonl` in full, STOP. Use 
a sibling, a cached artifact, or a bounded tail. The full raw is 
reserved for the operator's post-session normalize step.

# Sessions + timing

MNQ futures sessions (Pacific Time):
- Globex: starts 14:55 PT (current day), runs through 06:30 PT (next day). 
  Trading-date convention: labeled with the NEXT day's date.
- RTH: 06:30 PT through 13:05 PT (current day).
- Maintenance break: 13:05 PT through 14:55 PT.

Dashboard "session state" definitions:
- `globex_active` — current time is between 14:55 PT and 06:30 PT next day
- `rth_active` — current time is between 06:30 PT and 13:05 PT same day
- `between_sessions` — neither

# Probability framework

We have ZERO empirically-calibrated probabilities yet. RA-027's Wilson-CI 
multi-session HistoryReport requires ≥30 paired sessions to produce 
statistically grounded numbers. We have ~3 paired sessions and counting. 
The dashboard's probabilities are heuristic priors based on:

1. **Multi-method confluence strength** — tight confluence (≤10pt gap 
   between methods) = higher hold probability
2. **Statistical extension** — outside ±2σ = ~5% extreme territory
3. **Structural defense pattern** — recently-tested-and-held = real interest
4. **Trend continuation odds** — broken-and-extended levels favor 
   continuation; deep-retest favors reversal

Specific scenarios I framed (these are the 6 templates the dashboard 
should display, with example probability ranges):

1. **Scenario A — Confluence reversion long** at VPOC/-1σ confluence
   - Entry: tight confluence zone (e.g., 29,232-29,240)
   - P(T1) range: 60-72%
   - Conviction: HIGH
   - Best EV: +4.08 R-equivalent

2. **Scenario B1/B2 — VWAP magnet scalp** from ±1σ extremes
   - Entry: ±1σ band edge
   - P(T1) range: 55-65%
   - Conviction: MED

3. **Scenario C — Cycle-high fade** at LVN void cluster + +2σ
   - Entry: 3-way confluence (cycle high + LVN + +2σ)
   - P(T1) range: 55-70%
   - Conviction: MED-HIGH

4. **Scenario D — Breakdown short** below VPOC confluence
   - Entry: break below tight confluence with conviction
   - P(T1) range: 45-58%
   - Conviction: MED

5. **Scenario E — Breakout continuation** above cycle high
   - Entry: above cycle high with conviction
   - P(T1) range: 45-55%
   - Conviction: MED

6. **Scenario G — Stab-and-reverse long** below -2σ
   - Entry: below -2σ with arrest within 20pt
   - P(T1) range: 55-65%
   - Conviction: MED-HIGH on confirmation

The dashboard's update job is to recompute, every 15 minutes:
- The CURRENT price's distance from each scenario's entry zone (in points 
  + in ATR units)
- The "state" of each scenario (DORMANT / WATCHING / ACTIVE / IN-PROGRESS 
  / COMPLETED)
- Updated probability ranges based on heuristic multipliers (distance from 
  setup, time of session, CVD direction)

# Scenario state machine

Each of the 6 scenarios moves through these states based on current price:

- **DORMANT**: current price > 2 ATR away from scenario's entry zone OR 
  scenario's setup condition not yet possible (e.g., breakout scenario 
  before any test of the breakout level). Display probability range with 
  "not actionable" badge.
- **WATCHING**: price within 1-2 ATR of entry zone. Display full 
  probability range; alert that setup is approaching.
- **ACTIVE**: price within entry zone. Display "READY TO FIRE" + full 
  probability range + R:R if entry now.
- **IN-PROGRESS**: entry zone has been entered AND price hasn't hit T1/stop 
  yet (within session). Display "managing trade."
- **COMPLETED**: T1 or stop has been crossed. Display outcome 
  (target hit / stop hit / EOD close).

Track state transitions in an audit trail (last 50 state changes shown 
on dashboard).

# Probability heuristic update model

NOT a real Bayesian model — heuristic adjustments to the prior probability 
range. For each 15-min update:

```python
def adjust_probability_range(
    base_low: float,
    base_high: float,
    distance_atr: float,        # current price distance from entry, in ATR units
    matches_session_drift: bool, # session direction matches scenario bias?
    time_into_session_pct: float, # 0.0 at session open, 1.0 at close
    state: str,                  # DORMANT/WATCHING/ACTIVE/IN-PROGRESS/COMPLETED
) -> tuple[float, float]:
    """Adjust probability range based on context. Heuristic, not calibrated."""
    if state == "DORMANT" or state == "COMPLETED":
        # Don't update; static prior or N/A
        return (base_low, base_high)
    
    multiplier = 1.0
    
    # Closer to entry = more relevant/imminent (but not necessarily more probable)
    if distance_atr < 0.25:
        multiplier *= 1.0  # at entry zone, full prior applies
    elif distance_atr < 1.0:
        multiplier *= 0.95  # slight discount for approaching
    elif distance_atr < 2.0:
        multiplier *= 0.85
    else:
        multiplier *= 0.6
    
    # Session direction match
    if matches_session_drift:
        multiplier *= 1.15  # boost when context aligns
    else:
        multiplier *= 0.85  # discount when opposed
    
    # Late session = less time for setup to fire
    if time_into_session_pct > 0.8:
        multiplier *= 0.7
    
    # Clamp to [5%, 95%] to avoid false certainty
    adjusted_low = max(0.05, min(0.95, base_low * multiplier))
    adjusted_high = max(0.05, min(0.95, base_high * multiplier))
    
    return (adjusted_low, adjusted_high)
```

The dashboard displays the ADJUSTED range with a tooltip showing the 
adjustment factors. Keep the math transparent — don't pretend it's 
calibrated.

# Output: what kind of dashboard

A local HTML file (`data/dashboard/index.html`) regenerated every 15 min. 
Browser opens this file via `file:///`. The HTML has a meta-refresh tag 
to auto-reload every 15 min. Layout sections (detailed in analysis prompt):

1. **Header**: current price, time of last update, session state badge
2. **Distance-to-key-levels grid**: each level with distance + crossing direction
3. **Scenario status panel**: 6 scenarios with state + probability range + R:R
4. **Multi-method confluence visualization**: which levels agree
5. **Session signals dashboard** (when active session): first-30-min Globex 
   matrix, CVD direction, MBP1 health
6. **Audit trail**: last N state changes with timestamps

Dark mode (matches trading screens). Vanilla HTML + minimal CSS (Tailwind 
via CDN is fine, but pure CSS is simpler and works offline).

# Safety rules (immutable)

1. Never modify `.env`, credentials, or rithmic_analytics source code 
   that's not in your dashboard project.
2. Never make trading recommendations the user didn't ask for — 
   the dashboard is information display only.
3. Never call external APIs (yfinance, alpha vantage, etc.) — use only 
   the local capture files + zones JSON.
4. If a data source is missing or stale, surface that prominently in the 
   header (e.g., "WARNING: zones JSON is 3 days old"). Don't silently 
   degrade.

# Acknowledgment

After ingesting this context, respond with:
1. Your understanding of the project structure choice (sibling project vs 
   submodule)
2. Any clarifying questions about the trader profile, data sources, or 
   scenarios
3. Confirmation that you're ready for the analysis prompt

Do NOT start coding yet. Wait for the analysis prompt.
```
