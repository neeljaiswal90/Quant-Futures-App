# tv_sync executor agent prompt (RA-034 Phase 2)

Copy-paste this entire prompt into a fresh Claude Code session that has both
the **TradingView MCP** and **Claude in Chrome MCP** loaded. The agent will
execute the most recent `tv_sync` plan and write back the state file. Runs in
~30-60 seconds for a typical morning plan (5-15 ops per backend).

---

You are the tv_sync executor. Your job is to apply a pre-computed sync plan
to TV Desktop and/or Tradesea, then write back the state file so the next
`tv_sync --apply` run is idempotent.

## Step 1 — Locate and load the latest plan

Read `D:\Quant-futures-app\tools\rithmic_analytics\data\tv_sync_plans\_latest.json`.
It points to one or more plan files (one per backend that was synced).
For each plan path listed, read the full plan JSON.

If `_latest.json` doesn't exist, exit with: "No pending sync plan — run
`python -m rithmic_analytics.cli.tv_sync --apply` first."

## Step 2 — Process each plan

For each plan, you need:
- `plan.backend` — `"tv_desktop"` or `"tradesea"` (determines which MCP tools to use)
- `plan.chart_id` — used to derive the state file path
- `plan.state_path` — where to write back the updated state
- `plan.operations[]` — the list of ops to execute
- `plan.meta` — execution hints (time anchor pattern, iframe re-query reminder, etc.)

Initialize a `state_updates` dict mapping `source_id → shape_id`. Initialize
counters: `ok=0, failed=0, skipped=0`. Initialize a `failures` list for end
summary.

### Step 2a — For each operation in `plan.operations`

**`op.op == "noop"`**: increment `skipped`. Continue.

**`op.op == "remove"`** with `shape_id`:
- `tv_desktop`: call `mcp__tradingview__draw_remove_one(entity_id=op.shape_id)`.
- `tradesea`: inject JS via `mcp__Claude_in_Chrome__javascript_tool`:
  ```js
  const iframe = document.querySelector('iframe[id^="tradingview_"]');
  const ac = iframe.contentWindow.tradingViewApi.activeChart();
  try { ac.removeEntity('SHAPE_ID'); ({removed: true}); }
  catch (e) { ({removed: false, err: e.message}); }
  ```
  Substitute `SHAPE_ID` with `op.shape_id`. **Re-query the iframe every op**
  (don't cache the element — TV Charting Library remounts on chart-state changes).
- If the shape is already gone or removeEntity throws "not found": treat as
  success (shape is in the desired state). Increment `ok`. **Remove from
  `state_updates`** (don't carry a stale mapping forward).
- Any other error: increment `failed`, append to `failures`, **continue**
  (don't abort the run).

**`op.op == "add"`** with `source_id`, `kind` (`"reference_line"` or `"zone"`),
`price`, `label`, `style`:
- Compute time anchor: `Math.floor(Date.now() / 1000)`. **Do NOT use
  `getVisibleRange().to`** — that places labels in future-space off-screen
  (2026-05-20 incident).
- `tv_desktop` for `reference_line`:
  ```
  mcp__tradingview__draw_shape(
    shape="horizontal_line",
    point={"time": NOW_SECONDS, "price": op.price},
    text=op.label,
    overrides=json.dumps({
      "linecolor": style.color, "linewidth": style.width,
      "linestyle": style.linestyle, "showLabel": True,
      "textcolor": style.color, "fontsize": 9,
      "horzLabelsAlign": "right", "vertLabelsAlign": "middle"
    })
  )
  ```
  Capture the returned `entity_id`.
- `tv_desktop` for `zone` (rectangle): use `point` + `point2` (the plan provides
  both for zone ops). Same `mcp__tradingview__draw_shape` call with `shape="rectangle"`.
- `tradesea` for `reference_line`:
  ```js
  const iframe = document.querySelector('iframe[id^="tradingview_"]');
  const ac = iframe.contentWindow.tradingViewApi.activeChart();
  const nowSec = Math.floor(Date.now() / 1000);
  const id = ac.createShape(
    { time: nowSec, price: PRICE },
    { shape: 'horizontal_line', text: LABEL,
      overrides: { linecolor: COLOR, linewidth: WIDTH, linestyle: STYLE,
                   showLabel: true, textcolor: COLOR, fontsize: 9,
                   horzLabelsAlign: 'right', vertLabelsAlign: 'middle' } }
  );
  ({ shape_id: String(id) });
  ```
- `tradesea` for `zone` (rectangle): **use `createMultipointShape` — NO
  underscore**. The underscore-prefix internal `_createMultipointShape` only
  persists the first point (2026-05-20 incident). Both corners go in the
  `points` array:
  ```js
  ac.createMultipointShape(
    [{ time: T1, price: P1 }, { time: T2, price: P2 }],
    { shape: 'rectangle', text: LABEL, overrides: {...} }
  );
  ```
- On success, record `state_updates[op.source_id] = returned_shape_id`,
  increment `ok`.
- On failure, increment `failed`, append `{source_id, op_kind, error}` to
  `failures`, **continue**.

### Step 2b — Write back the state file

After all ops for this plan execute (regardless of failures), merge
`state_updates` into the existing state file at `plan.state_path`:

1. Read the existing state file. If it doesn't exist, treat as empty dict.
2. For each `(source_id, shape_id)` in `state_updates`: set
   `state[source_id] = shape_id`.
3. For each `source_id` that was REMOVED (op.op == "remove" succeeded):
   delete from `state`.
4. Write back atomically: write to `<state_path>.tmp` then rename to
   `<state_path>`.

The state file shape is a flat JSON object:
```json
{
  "vpoc-29105": "QTq8wD",
  "vah-29155": "SHfrFB",
  "hvn-29105-globex": "abc123"
}
```

## Step 3 — Summary

After all plans process, report to the user:

```
tv_sync executor results:
  tv_desktop: 5 ok, 0 failed, 12 skipped (noop)
  tradesea:   5 ok, 0 failed, 12 skipped (noop)

State files updated:
  data/tv_sync_state/tv_desktop_MNQ.json
  data/tv_sync_state/tradesea_MNQ.json
```

If `failed > 0`, list the failures:
```
Failures:
  tradesea / vwap_rth_band_p1sd / add: ReferenceError: createShape is not defined
  tv_desktop / hvn-28920-globex / remove: shape not found
```

## Failure handling philosophy

- **Per-op failures don't abort the run.** Continue executing remaining ops.
  The state file write captures successful ops even when some failed.
- **Per-backend failures don't gate other backends.** If Tradesea iframe is
  missing (tab closed), TV Desktop ops still execute.
- **Idempotent retry**: if you re-run after a partial failure, the next plan
  generated by `tv_sync --apply` will skip the already-applied ops (state
  file knows about them) and retry the failed ones.

## Verification (optional but recommended)

After executing, call `mcp__tradingview__capture_screenshot` and
`mcp__Claude_in_Chrome__javascript_tool` to enumerate post-state on both
backends. Compare against expected count from the plan. Useful for catching
silent "createShape returned but shape didn't actually render" bugs (the
async-commit race condition seen in 2026-05-20 session — the returned
`shape_id` is valid, but `getAllShapes()` may not reflect the new shape
for ~50-200ms after createShape resolves).

## Common pitfalls (recap)

| Pitfall | Mitigation |
|---|---|
| Iframe ID changed mid-run | Re-query `iframe[id^="tradingview_"]` every op |
| Rectangle only one corner | Use `createMultipointShape` (no underscore) |
| Labels off-screen in future-space | Anchor at `Math.floor(Date.now()/1000)` not `vr.to` |
| Stale state file after crash | State writes are atomic (.tmp + rename) |
| Indicator-emitted zones in chart | `getAllShapes()` only returns user shapes; tv_sync doesn't see them; they stay untouched |
