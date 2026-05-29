# Quarterly Rollover Playbook (RA-025)

Operator runbook for handling CME E-mini Micro Nasdaq (MNQ) quarterly
contract rollovers in this analytics pipeline.

## Why this exists

MNQ trades quarterly contracts: `MNQH{Y}` (March), `MNQM{Y}` (June),
`MNQU{Y}` (September), `MNQZ{Y}` (December). Each expires on the **3rd
Friday** of its expiry month. Liquidity rolls from the front month to the
next a week before expiration — specifically, the **Friday 7 days before
the 3rd Friday** (= 2nd Friday of the expiry month).

`ops/rollover_calendar.py` hardcodes this schedule through 2027 Q4. The
analytics layer resolves the front month at runtime via
`resolve_front_month("MNQ", today)`. If the calendar is exhausted (today is
past the last `expiry_date`), `RolloverCalendarMiss` raises with a message
telling the operator to extend the table.

**This playbook is the procedure for the maintenance day before each roll.**

## Current calendar (as of project state)

| Front-month start | Contract | Outgoing expires |
|---|---|---|
| 2026-03-13 | MNQM6 | 2026-06-19 |
| **2026-06-12** | **MNQU6** | **2026-09-18** |
| 2026-09-11 | MNQZ6 | 2026-12-18 |
| 2026-12-11 | MNQH7 | 2027-03-19 |
| 2027-03-12 | MNQM7 | 2027-06-18 |
| 2027-06-11 | MNQU7 | 2027-09-17 |
| 2027-09-10 | MNQZ7 | 2027-12-17 |
| 2027-12-10 | MNQH8 | 2028-03-17 |

**Next roll: 2026-06-12 (MNQM6 → MNQU6).** That's the one to use as the
training run for this playbook.

## The week-before checklist (T-7 days before a roll)

Run through this on the Friday/weekend *before* the rollover Friday.

### 1. Confirm the calendar has the entry

```powershell
python -c "
from datetime import date
from rithmic_analytics.ops.rollover_calendar import resolve_front_month
print('Today:', resolve_front_month('MNQ', date.today()))
print('Day before roll:', resolve_front_month('MNQ', date(2026, 6, 11)))
print('Roll day:', resolve_front_month('MNQ', date(2026, 6, 12)))
print('After roll:', resolve_front_month('MNQ', date(2026, 6, 13)))
"
```

Expect:
```
Today: MNQM6
Day before roll: MNQM6
Roll day: MNQU6
After roll: MNQU6
```

If you see `MNQM6` on or after the roll date, the calendar entry is missing.
**Stop and add it** (see below).

### 2. Cross-check the CME calendar

Open https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.calendar.html
(or any CME futures calendar of record) and verify:
- The outgoing contract's last trading day matches our `expiry_date`
- The new front month's first-notice / first-trade day is *before* our
  configured `rollover_date`

If CME has shifted the schedule (rare, but does happen for holiday weeks),
update `_MNQ_ROLLOVERS` in `ops/rollover_calendar.py` and re-run step 1.

### 3. TradingView continuous-contract references

Neel's existing chart-drawing tools in `D:\MNQ-Futures\tools\` use
TradingView symbols like `MNQ1!` (continuous front-month). **TradingView
handles the roll automatically** — `MNQ1!` becomes a chart of MNQU6 on the
roll day. No action required on the TV side.

**Watch out for**: zone JSONs generated *before* the roll using MNQM6 data
are still valid intraday references the day of the roll. They just describe
the outgoing contract's day. Don't blindly carry them into the new contract
without inspection — MNQU6 may have different statistical bands.

### 4. Verify the capture pipeline will pick up the new contract

The `RithmicCapture_RTH` task invokes `start_capture --root-symbol MNQ` —
it resolves the front-month at launch time. **No task re-registration
required.** Confirm by inspecting the next-day's wrapper log:

```powershell
Get-Content data\captures\2026-06-15\wrapper.log -Head 20
```

Expect a line referencing `MNQU6` (the new contract) in the probe
invocation. If you still see `MNQM6` after the rollover date, the calendar
file wasn't reloaded — restart the Python environment or re-import the
package.

### 5. Decide on archive retention for the outgoing contract

The retention policy (RA-008) keeps raw captures for the last 2 trading
days and compressed archives for 14 days. After a rollover, the outgoing
contract's captures age out normally. **No special action.**

**Exception**: if you want to preserve a quarter's worth of MNQM6 data for
back-testing the absorption / VP feature on a full quarterly window:

```powershell
# Before the 14-day cutoff, copy out
Copy-Item -Recurse data\captures_archive\2026-05-*  D:\Quant-futures-app\backtest_archive\MNQM6\
```

Out-of-scope for retention.py — manual operator decision.

### 6. session_id format across the rollover crossover

`session_id` in capture envelopes is `mnq-{trading_date}-{rth|globex}` —
**not contract-specific**. So:
- `mnq-2026-06-11-rth` captures MNQM6 data
- `mnq-2026-06-12-rth` captures MNQU6 data
- Both sit under `data/captures/2026-06-12/` if that's the trading date

If you want to know *which contract* a session_id corresponds to, cross-
reference with `data/captures/<date>/wrapper.log` (the wrapper logs the
resolved contract at launch).

## Extending the calendar (post-2027 maintenance)

The hardcoded table in `ops/rollover_calendar.py` covers through 2027 Q4.
Before late 2027, extend it:

1. Compute the 3rd Friday of each future expiry month
2. Subtract 7 days → that's the new `rollover_date` (it lands on a Friday)
3. Append a `RolloverEntry(rollover_date=..., contract="MNQX{Y}",
   expiry_date=...)` to `_MNQ_ROLLOVERS`
4. `_validate_calendar()` runs at import — it enforces order + sanity. A
   miscomputed date will fail-fast
5. Run `pytest tests/test_rollover_calendar.py` — should still pass
6. Optionally extend the test fixture dates in
   `test_2027_resolves_correctly_across_year_boundary` to cover 2028

### Computing the dates by hand

```
def third_friday(year, month):
    first = date(year, month, 1)
    weekday_of_first = first.weekday()  # Monday=0, Sunday=6
    # First Friday = day where (4 - weekday_of_first) % 7 + 1
    first_friday = 1 + ((4 - weekday_of_first) % 7)
    return date(year, month, first_friday + 14)
```

Or just check a calendar — there are only 4 per year for 4 years out.

## Edge cases handled

### Rollover Friday falls on a holiday

E.g., Good Friday in some years (no precedent in MNQ but possible for
related contracts). In that case CME shifts the *expiry* — typically to
the Thursday before. The `rollover_date` shifts by the same amount. Update
manually if it ever happens; the rule of "1 week before expiry" stays
intact.

### Operator forgot to extend the calendar

`resolve_front_month` raises `RolloverCalendarMiss` with a message naming
the last entry's `expiry_date`. The wrapper at `start_capture.py` translates
this to wrapper exit code 2 (bad config). Task Scheduler shows the failed
run; the runbook at `task_scheduler_setup.md` directs the operator to this
playbook.

The system is designed to **fail loud** rather than silently capture stale
contract data — the alternative (silently picking up the outgoing contract
post-expiry) would produce zero-volume captures that look real.

### Manual override needed mid-roll

The `--contract-override` flag on `start_capture` bypasses the calendar:

```powershell
python -m rithmic_analytics.cli.start_capture `
    --root-symbol MNQ --session rth `
    --contract-override MNQU6
```

This logs a single audit line: `[rollover-override] using MNQU6 (manual
override) — resolved=MNQM6 — today=2026-06-11`. Use sparingly; the audit
trail surfaces the deliberate choice in `data/captures/<date>/wrapper.log`.

## Reference

- `ops/rollover_calendar.py` — the hardcoded table and `resolve_front_month`
- `cli/start_capture.py` — the wrapper that consumes it
- `architecture.md` D-001 / D-002 / D-003 — adjacent decisions
- `task_scheduler_setup.md` — operational runbook (this is the rollover
  subset of that runbook)
- CME source of truth: https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html
