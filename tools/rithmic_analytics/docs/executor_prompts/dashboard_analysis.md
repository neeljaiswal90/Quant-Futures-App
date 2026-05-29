# Codex Prompt 2 of 3 — Dashboard ANALYSIS

Send this AFTER Codex has acknowledged the contextual prompt. Specifies 
exactly what to compute, what to display, and the page structure. Codex 
should pre-build sweep, then implement.

---

# Copy-paste below

```
With the context from Prompt 1 ingested, here's the analytical 
specification for the dashboard. This is the "what gets computed and 
displayed" spec. After ingesting this prompt, do a pre-build ambiguity 
sweep (the proven 10x-velocity discipline), then build.

# Modules to build

## Module 1: `level_distances.py`

Functions:
- `compute_level_distances(envelope: dict, current_price: float, atr: float) -> list[LevelDistance]`
  
`LevelDistance` dataclass:
- `level_id: str`
- `price: float`
- `text: str`         # e.g., "5/21 RTH VPOC 29,237.5"
- `source: str`       # e.g., "vpoc", "vah", "vwap_rth", "lvn_rth", "hvn_rth"
- `conviction: Literal["SUPER", "HIGH", "MED", "LOW"] | None`
- `distance_pts: float`           # signed: positive = level above price
- `distance_atr: float`           # signed
- `direction: Literal["above", "below", "at"]`  # "at" if |distance| < 1 tick
- `state: Literal["approaching", "crossing", "moved_away"]`  # vs prior tick

Compute distance against each `reference_lines` entry AND each `zones` 
entry (use zone's midpoint for distance). Sort by absolute distance ascending.

Cross-state requires prior price (read from a state file — `data/dashboard/_state.json`).
State entry shape: `{level_id: {"last_distance_pts": float, "last_check_pt": ISO timestamp}}`.

## Module 2: `scenario_state.py`

Functions:
- `compute_scenario_states(envelope: dict, current_price: float, atr: float, audit_trail: list) -> list[ScenarioState]`

`ScenarioState` dataclass (per the 6 scenarios from the context prompt):
- `scenario_id: Literal["A", "B1", "B2", "C", "D", "E", "G"]`
- `name: str`              # e.g., "Confluence reversion long"
- `direction: Literal["long", "short"]`
- `state: Literal["DORMANT", "WATCHING", "ACTIVE", "IN_PROGRESS", "COMPLETED"]`
- `entry_zone_low: float`
- `entry_zone_high: float`
- `stop: float`
- `target_1: float`
- `target_2: float | None`
- `target_3: float | None`
- `prior_prob_low: float`     # the original prior range from context prompt
- `prior_prob_high: float`
- `adjusted_prob_low: float`  # after heuristic adjustment
- `adjusted_prob_high: float`
- `r_multiple_t1: float`      # (T1 - entry_mid) / (entry_mid - stop), signed for direction
- `r_multiple_t2: float | None`
- `r_multiple_t3: float | None`
- `current_r: float`          # if state==ACTIVE/IN_PROGRESS, current P&L in R-units; else 0

Map each scenario template to current envelope:
- **A**: entry zone = VPOC ± 5pt; stop = VAL or -2σ; T1 = VWAP; T2 = +1σ; T3 = cycle high
- **B1**: entry = -1σ-touched zone (29,250 range); stop = -2σ; T1 = VWAP
- **B2**: entry = +1σ-touched zone; stop = above +2σ; T1 = VWAP
- **C**: entry = +2σ + LVN cluster + cycle high (find tightest 3-method confluence above VWAP); stop = above cycle high + 10pt; T1 = +1σ; T2 = VWAP
- **D**: entry = below VPOC zone with confirmation; stop = above VPOC + buffer; T1 = VAL; T2 = RTH low; T3 = prior Globex low
- **E**: entry = above cycle high; stop = below; T1 = 1.272 Fib extension; T2 = round-number psychological
- **G**: entry = below -2σ + arrest; stop = below -2σ - 20pt; T1 = -1σ; T2 = VWAP

State transitions:
- DORMANT → WATCHING when |distance_to_entry_mid| < 2 ATR
- WATCHING → ACTIVE when current_price is inside the entry zone
- ACTIVE → IN_PROGRESS when current_price moves >5pt favorable past entry (i.e., entry filled)
- IN_PROGRESS → COMPLETED when current_price hits T1 (target_hit) or stop (stop_hit)
- COMPLETED stays COMPLETED for the session

Persist scenario state in `data/dashboard/_scenarios.json` keyed by 
`<date>_<session>_<scenario_id>`. Reset on new session.

## Module 3: `probability_adjuster.py`

The heuristic adjustment function from the context prompt. Take prior 
range + context (distance_atr, matches_session_drift, time_into_session_pct, 
state) → adjusted range clamped to [5%, 95%].

`adjust(prior_low: float, prior_high: float, **context) -> tuple[float, float]`.

Document the multipliers transparently in a separate `get_adjustment_factors()` 
function that returns the breakdown for tooltip display.

## Module 4: `confluence.py`

Compute tight-confluence groups. A "tight confluence" is ≥2 reference 
levels within 10pt of each other.

`compute_confluence_groups(envelope: dict, max_gap_pts: float = 10.0) -> list[ConfluenceGroup]`

`ConfluenceGroup` dataclass:
- `levels: list[LevelDistance]`
- `center_price: float`   # mean of group prices
- `span_pts: float`       # max - min in group
- `tightness: Literal["TIGHT", "LOOSE"]`   # TIGHT if span_pts < 5
- `conviction_score: Literal["SUPER", "HIGH", "MED", "LOW"]`
  # SUPER if 3+ methods in TIGHT group; HIGH if 2 methods TIGHT; MED if LOOSE 2-method; LOW if single

For 2026-05-21 example, the tight confluences are:
- {VPOC 29,237.5, -1σ 29,232.7} = 4.8pt span → HIGH
- {Cycle High 29,553.75, LVN 29,552.5, LVN 29,550, +2σ 29,546.34} = 7.4pt span → SUPER
- {RTH Low 29,138, LVN 29,137.5, LVN 29,140, -2σ 29,128.17} = 11.8pt span → HIGH (just outside TIGHT)

## Module 5: `session_signals.py`

Compute the first-30-min Globex confirmation matrix when current time is 
in the first 30 min of an active session.

`compute_session_signals(envelope: dict, capture_file: Path, current_price: float, session_start: datetime) -> SessionSignals | None`

Returns None if not within first 30 min of session.

`SessionSignals` dataclass:
- `open_print: float`              # first LAST_TRADE price after session start
- `open_vs_close_ref: Literal["above", "below", "at"]`  # vs the Globex Open ref
- `first_30min_vwap: float | None`  # only after sufficient data
- `first_30min_vwap_vs_threshold: Literal["bull", "bear", "neutral"]`
- `net_cvd_30min: int | None`       # buy_qty - sell_qty in first 30 min
- `cvd_direction: Literal["bull", "bear", "neutral"]`  # vs ±500 threshold
- `first_test_of_lower_confluence: bool   # did price tag the VPOC/-1σ zone?
- `first_test_of_upper_confluence: bool   # did price tag VAH/+1σ zone?

## Module 6: `audit_trail.py`

Track state changes for display.

- `AuditEntry`: `{timestamp_pt, event_type, description, related_level_id}`
- Event types: `level_crossed`, `scenario_state_change`, `confluence_break`, `data_warning`
- Persist last 50 entries in `data/dashboard/_audit.json`
- Display last 20 on the dashboard

## Module 7: `dashboard_renderer.py`

Generates the HTML page. Use Jinja2 + a single template at 
`templates/dashboard.html.j2`.

HTML structure:
- `<meta http-equiv="refresh" content="900">` (15 min auto-reload)
- Dark mode (background #0a0a0a, text #e5e5e5, accent #84CC16 for HIGH, 
  #DC2626 for resistance, #22D3EE for support markers)
- Responsive single-page layout

Sections (top to bottom):

### Section 1: Header bar
- Current MNQ price (large, bold, monospace)
- Last update time PT (small, with "data age: X min" warning if >15 min)
- Session state badge: `GLOBEX ACTIVE` (green) / `RTH ACTIVE` (blue) / 
  `BETWEEN SESSIONS` (gray)
- Session timing: "Globex closes in 4h 23m" or similar
- Data freshness indicators: zones JSON age, capture file age

### Section 2: Distance-to-key-levels grid
A table with columns: Level | Price | Distance (pts) | Distance (ATR) | 
Direction | State

Rows sorted by absolute distance, top 12-15 levels. Color-code by 
conviction (SUPER red bold, HIGH yellow, MED gray).

### Section 3: Scenario status panel
6 cards (or 1 per row in tight column layout):

Each card shows:
- Scenario letter + name (e.g., "A — Confluence reversion long")
- State badge: DORMANT (gray) / WATCHING (yellow) / ACTIVE (green) / 
  IN_PROGRESS (orange) / COMPLETED (grayed out)
- Direction icon (↑ long / ↓ short)
- Entry zone (Low–High)
- Stop / T1 / T2 / T3 prices
- R:R for T1 (e.g., "6.7R")
- Probability range badge: "60-72%" with tooltip showing prior + adjustment 
  multipliers
- "Current R" if IN_PROGRESS

Sort by: ACTIVE first, then WATCHING, then DORMANT, then COMPLETED.

### Section 4: Multi-method confluence visualization
For each ConfluenceGroup:
- Group center price
- Color block per method (VPOC=lime, σ=red/green, LVN=cyan, etc.)
- Span pts
- Conviction badge

Simple horizontal-bar visualization works fine — each method is a colored 
dot at its price; tight groups appear visually clustered.

### Section 5: Session signals (only when active session, first 30 min)
- 5-row grid:
  - Open print vs ref → bull/bear icon
  - First-30min VWAP vs threshold → icon
  - Net CVD 30min → number + icon
  - First test of lower confluence → ✓/—
  - First test of upper confluence → ✓/—

After first 30 min, hide this section or show a "30-min window closed; 
signals captured at HH:MM" summary.

### Section 6: Audit trail
Last 20 events in chronological order (most recent first). One line each:
- Timestamp PT (e.g., "14:42 PT")
- Event icon
- Description (e.g., "Price crossed 5/21 RTH VWAP 29,337.25 from below" or 
  "Scenario A → WATCHING (price within 2 ATR of VPOC)")

### Section 7: Footer
- Methodology disclosure: "Probabilities are heuristic priors with 
  multi-method confluence + structural-pattern adjustments. NOT 
  empirically calibrated until RA-027 HistoryReport accumulates ≥30 paired 
  sessions."
- Source attribution: zones JSON path, capture file path, last update.
- Manual refresh button (just `<a href="/" onclick="location.reload()">↻</a>`).

# CLI entry point

`rithmic_dashboard/cli/generate.py` (or wherever the new project lives):

```python
def main():
    """Generate dashboard HTML. Called every 15 min by automation."""
    args = parse_args()  # --output-path, --force, etc.
    
    # 1. Determine current session + trading date
    session_state = determine_session_state(now_pt=datetime.now())
    
    # 2. Load envelope (zones JSON)
    envelope = load_envelope(trading_date=session_state.trading_date)
    if envelope is None:
        write_data_warning_page("Zones JSON missing for trading date")
        return
    
    # 3. Get current price (from live capture file)
    current_price = get_current_price(capture_file=session_state.capture_path)
    
    # 4. Compute all derived data
    distances = compute_level_distances(envelope, current_price, envelope['atr_14'])
    scenarios = compute_scenario_states(envelope, current_price, envelope['atr_14'], audit)
    confluence = compute_confluence_groups(envelope)
    signals = compute_session_signals(...) if session_state.first_30min else None
    audit = update_audit_trail(prior_state, current_state)
    
    # 5. Render
    html = render_dashboard(
        envelope=envelope,
        current_price=current_price,
        distances=distances,
        scenarios=scenarios,
        confluence=confluence,
        signals=signals,
        audit=audit,
        session_state=session_state,
    )
    
    # 6. Write
    write_html(html, output_path=args.output_path)
```

# Tests required

- `test_level_distances.py` — synthetic envelope + current price → expected 
  distances + direction
- `test_scenario_state.py` — state transitions on each direction; 
  scenario-specific entry/stop/target mappings
- `test_probability_adjuster.py` — boundary cases (distance_atr=0, 5, 10; 
  state=DORMANT skip; clamp to [5%, 95%])
- `test_confluence.py` — known confluence groups from 2026-05-21 data 
  match expected (the 4.8pt VPOC/-1σ group, etc.)
- `test_session_signals.py` — synthetic capture file → expected signals
- `test_audit_trail.py` — state file load/save, last-50-entries truncation
- `test_dashboard_renderer.py` — Jinja template renders without errors 
  for full data + empty/missing-data fallback
- `test_cli_generate.py` — end-to-end with synthetic envelope + tiny 
  capture file → valid HTML output

Target: ≥30 tests. Match the rithmic_analytics quality bar.

# Acceptance criteria

- `python -m rithmic_dashboard.cli.generate` writes `data/dashboard/index.html` 
  in <3 seconds
- HTML is valid (no broken tags), self-contained (no external CSS/JS 
  except CDN-loaded Tailwind if used)
- Opens in Chrome / Edge / Firefox without errors
- Meta-refresh fires every 15 min
- All 6 scenarios render with correct state for the example envelope 
  (2026-05-21 RTH zones JSON)
- Audit trail correctly tracks the first state change after a synthetic 
  price move
- Dark mode renders cleanly with no white flashes on refresh
- ruff + mypy clean
- All tests pass

# Pre-build sweep expectation

Surface questions BEFORE coding:

1. Architectural choice: sibling project at `tools/rithmic_dashboard/` OR 
   submodule inside `rithmic_analytics`?
2. State file layout: separate files per concern (`_scenarios.json`, 
   `_audit.json`, `_state.json`) OR one combined dashboard state file?
3. Should the dashboard fail closed (refuse to render if data is missing) 
   or fail open (render with warnings)?
4. Should the audit trail show ALL state changes or only "actionable" ones 
   (scenario state changes, confluence crossings — not every level cross)?
5. CSS framework: pure CSS (smaller, offline-safe) vs Tailwind CDN 
   (faster to write, requires network on first load)?

Recommend defaults; surface ambiguity; wait for green-light before coding.

# Standing by

Send the automation prompt after this prompt is acknowledged and the 
analysis-side build is complete (or at minimum, the sweep is approved).
```
