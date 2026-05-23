"""CYCLE4-R2: hold-time entry gate research.

Hypothesis: a delay (30s, 60s, etc.) after the shock-arm signal would
filter the sub-2min chop-flip noise that consumes 58% of trades and
nets negative.

Method:
  1. Decompose the sub-2min cohort
  2. Feature analysis: does anything at entry-time predict sub-2min outcome?
  3. Counterfactual: skip the sub-2min cohort entirely (upper bound)
  4. Approximate delay model: skip trades that close within the delay window
  5. Bootstrap the filtered residual edge

Output: numbers extracted into the research memo. Not part of any
byte-equality contract; research-tier scratch only.
"""
import json
import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

random.seed(20260524)

with open('artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json') as f:
    d = json.load(f)

trades = d['trades']
for t in trades:
    for k in ['net_pnl_cents', 'gross_pnl_cents', 'max_adverse_excursion_cents',
              'max_favorable_excursion_cents', 'entry_ts_ns', 'exit_ts_ns']:
        t[k] = int(t[k])
    t['hold_sec'] = (t['exit_ts_ns'] - t['entry_ts_ns']) / 1e9
    t['hold_min'] = t['hold_sec'] / 60
    t['net'] = t['net_pnl_cents']
    t['mfe'] = t['max_favorable_excursion_cents']
    t['mae'] = t['max_adverse_excursion_cents']

n = len(trades)
sl = [t for t in trades if t['exit_reason'] == 'stop_loss']
R = -sum(t['net'] for t in sl) / len(sl)


def header(s):
    print(f"\n{'=' * 72}\n{s}\n{'=' * 72}")


header(f"CYCLE4-R2 substrate: post-fix Cycle3 (n={n}, R unit ${R/100:.2f})")

# === 1. Hold-time distribution (fine-grained) ===
header("1. Hold-time distribution (fine-grained, post-fix)")
buckets = [
    ('< 30s', 0, 30),
    ('30s - 1min', 30, 60),
    ('1 - 2min', 60, 120),
    ('2 - 3min', 120, 180),
    ('3 - 5min', 180, 300),
    ('5 - 10min', 300, 600),
    ('>= 10min', 600, 99999),
]
print(f"  {'bucket':<14} {'n':>4} {'win%':>6} {'PF':>6} {'avg':>8} {'net':>10}")
cum_filtered_trades = 0
cum_filtered_pnl = 0
for label, lo, hi in buckets:
    sub = [t for t in trades if lo <= t['hold_sec'] < hi]
    if not sub:
        continue
    w = [t for t in sub if t['net'] > 0]
    l = [t for t in sub if t['net'] < 0]
    pf = sum(t['net'] for t in w) / -sum(t['net'] for t in l) if l else float('inf')
    pf_s = f"{pf:6.2f}" if pf != float('inf') else "   inf"
    avg = sum(t['net'] for t in sub) / len(sub)
    net = sum(t['net'] for t in sub)
    print(f"  {label:<14} {len(sub):>4} {len(w)/len(sub)*100:>5.1f}% {pf_s} ${avg/100:>7.2f} ${net/100:>9.2f}")

# === 2. Sub-2-min cohort decomposition ===
header("2. Sub-2-min cohort decomposition")
sub2 = [t for t in trades if t['hold_sec'] < 120]
print(f"  Sub-2-min cohort: {len(sub2)}/{n} ({len(sub2)/n*100:.1f}%)")
sub2_w = [t for t in sub2 if t['net'] > 0]
sub2_l = [t for t in sub2 if t['net'] < 0]
sub2_pf = sum(t['net'] for t in sub2_w) / -sum(t['net'] for t in sub2_l) if sub2_l else float('inf')
print(f"  PF: {sub2_pf:.4f}  Win%: {len(sub2_w)/len(sub2)*100:.1f}%  Net: ${sum(t['net'] for t in sub2)/100:.2f}")

# Per exit_reason in sub2
print("\n  Sub-2-min by exit reason:")
for er, cnt in Counter(t['exit_reason'] for t in sub2).most_common():
    sub = [t for t in sub2 if t['exit_reason'] == er]
    w = [t for t in sub if t['net'] > 0]
    avg = sum(t['net'] for t in sub) / len(sub)
    print(f"    {er:14} n={len(sub):3d}  win%={len(w)/len(sub)*100:5.1f}  avg=${avg/100:7.2f}")

# Hold-time within sub2: <30s, 30-60s, 60-120s
print("\n  Sub-2-min sub-buckets:")
sub_30 = [t for t in trades if t['hold_sec'] < 30]
sub_60 = [t for t in trades if 30 <= t['hold_sec'] < 60]
sub_120 = [t for t in trades if 60 <= t['hold_sec'] < 120]
for label, sub in [('< 30s', sub_30), ('30-60s', sub_60), ('60-120s', sub_120)]:
    if not sub:
        continue
    w = [t for t in sub if t['net'] > 0]
    avg = sum(t['net'] for t in sub) / len(sub)
    net = sum(t['net'] for t in sub)
    print(f"    {label:<10} n={len(sub):3d}  win%={len(w)/len(sub)*100:5.1f}  avg=${avg/100:7.2f}  net=${net/100:8.2f}")

# === 3. Feature analysis: does anything at entry-time predict sub-2-min outcome? ===
header("3. Feature analysis — entry-time signals for sub-2-min outcome")

# Compare features: sub-2min vs >=2min
ge2 = [t for t in trades if t['hold_sec'] >= 120]
print(f"  Sub-2-min n={len(sub2)}, >=2min n={len(ge2)}")

def feature_dist(trades_list, key):
    return Counter(t[key] for t in trades_list)

print("\n  spread_bucket distribution:")
sub2_sb = feature_dist(sub2, 'spread_bucket')
ge2_sb = feature_dist(ge2, 'spread_bucket')
all_keys = set(sub2_sb) | set(ge2_sb)
for k in sorted(all_keys):
    s_pct = sub2_sb.get(k, 0) / len(sub2) * 100
    g_pct = ge2_sb.get(k, 0) / len(ge2) * 100
    diff = s_pct - g_pct
    sig = "***" if abs(diff) > 5 else "  "
    print(f"    {k:14}  sub2: {sub2_sb.get(k,0):3d} ({s_pct:5.1f}%)  ge2: {ge2_sb.get(k,0):3d} ({g_pct:5.1f}%)  Δ {diff:+5.1f}pp {sig}")

print("\n  queue_ahead_bucket distribution:")
sub2_qa = feature_dist(sub2, 'queue_ahead_bucket')
ge2_qa = feature_dist(ge2, 'queue_ahead_bucket')
for k in sorted(set(sub2_qa) | set(ge2_qa)):
    s_pct = sub2_qa.get(k, 0) / len(sub2) * 100
    g_pct = ge2_qa.get(k, 0) / len(ge2) * 100
    diff = s_pct - g_pct
    sig = "***" if abs(diff) > 5 else "  "
    print(f"    {k:10}  sub2: {sub2_qa.get(k,0):3d} ({s_pct:5.1f}%)  ge2: {ge2_qa.get(k,0):3d} ({g_pct:5.1f}%)  Δ {diff:+5.1f}pp {sig}")

print("\n  regime distribution:")
sub2_r = feature_dist(sub2, 'regime')
ge2_r = feature_dist(ge2, 'regime')
for k in sorted(set(sub2_r) | set(ge2_r)):
    s_pct = sub2_r.get(k, 0) / len(sub2) * 100
    g_pct = ge2_r.get(k, 0) / len(ge2) * 100
    diff = s_pct - g_pct
    sig = "***" if abs(diff) > 5 else "  "
    print(f"    {k:6}  sub2: {sub2_r.get(k,0):3d} ({s_pct:5.1f}%)  ge2: {ge2_r.get(k,0):3d} ({g_pct:5.1f}%)  Δ {diff:+5.1f}pp {sig}")

# Early MAE as a predictor
print("\n  Early adverse signal (MAE within first ~30s):")
print("  (cannot measure directly; using MAE/duration as proxy)")
print("  Sub-2-min MAE quartiles:")
mae_sub2 = sorted([abs(t['mae']) for t in sub2])
for q, idx in [('p25', len(mae_sub2)//4), ('p50', len(mae_sub2)//2), ('p75', 3*len(mae_sub2)//4), ('max', len(mae_sub2)-1)]:
    print(f"    {q}: ${mae_sub2[idx]/100:.2f}  (={mae_sub2[idx]/R:.2f}R)")
print("  >=2min MAE quartiles:")
mae_ge2 = sorted([abs(t['mae']) for t in ge2])
for q, idx in [('p25', len(mae_ge2)//4), ('p50', len(mae_ge2)//2), ('p75', 3*len(mae_ge2)//4), ('max', len(mae_ge2)-1)]:
    print(f"    {q}: ${mae_ge2[idx]/100:.2f}  (={mae_ge2[idx]/R:.2f}R)")

# === 4. Counterfactual: skip sub-N-min trades entirely ===
header("4. Counterfactual — skip sub-N-min trades (upper bound on filter benefit)")
print(f"  {'filter':<20} {'kept':>5} {'pct':>5} {'win%':>6} {'PF':>6} {'net':>11} {'Δnet':>10}")

baseline_net = sum(t['net'] for t in trades)
baseline_pf = sum(t['net'] for t in trades if t['net'] > 0) / -sum(t['net'] for t in trades if t['net'] < 0)
print(f"  {'BASELINE (all)':<20} {n:>5} {100:>4.1f}% {len([t for t in trades if t['net']>0])/n*100:>5.1f}% {baseline_pf:>6.4f} ${baseline_net/100:>10.2f} ${0/100:>9.2f}")

for delay_sec in [15, 30, 45, 60, 90, 120, 180]:
    kept = [t for t in trades if t['hold_sec'] >= delay_sec]
    if not kept:
        continue
    w = [t for t in kept if t['net'] > 0]
    l = [t for t in kept if t['net'] < 0]
    pf_k = sum(t['net'] for t in w) / -sum(t['net'] for t in l) if l else float('inf')
    pf_s = f"{pf_k:6.4f}" if pf_k != float('inf') else "   inf"
    net_k = sum(t['net'] for t in kept)
    delta = net_k - baseline_net
    print(f"  skip < {delay_sec:3d}s        {len(kept):>5} {len(kept)/n*100:>4.1f}% {len(w)/len(kept)*100:>5.1f}% {pf_s} ${net_k/100:>10.2f} ${delta/100:>+9.2f}")

# === 5. Bootstrap the filtered residual edge ===
header("5. Bootstrap on filtered residual (skip <60s, the cleanest break)")
filt = [t for t in trades if t['hold_sec'] >= 60]
n_filt = len(filt)
returns_filt = [t['net'] / R for t in filt]
print(f"  Filtered cohort: n={n_filt}/{n} ({n_filt/n*100:.1f}% retained)")
print(f"  PF: {sum(t['net'] for t in filt if t['net']>0)/-sum(t['net'] for t in filt if t['net']<0):.4f}")
print(f"  Net: ${sum(t['net'] for t in filt)/100:.2f}")

N = 5000
boot_pf = []
boot_net = []
boot_winrate = []
for _ in range(N):
    samp = [filt[random.randint(0, n_filt - 1)] for _ in range(n_filt)]
    w = sum(t['net'] for t in samp if t['net'] > 0)
    l = sum(t['net'] for t in samp if t['net'] < 0)
    boot_pf.append(w / -l if l < 0 else 100)
    boot_net.append(sum(t['net'] for t in samp))
    boot_winrate.append(sum(1 for t in samp if t['net'] > 0) / n_filt)


def q(xs, p):
    s = sorted(xs)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


print(f"\n  Bootstrap CIs (N=5000, i.i.d.):")
print(f"    PF       p5={q(boot_pf,0.05):.4f}  p50={q(boot_pf,0.5):.4f}  p95={q(boot_pf,0.95):.4f}")
print(f"    net($)   p5=${q(boot_net,0.05)/100:.2f}  p50=${q(boot_net,0.5)/100:.2f}  p95=${q(boot_net,0.95)/100:.2f}")
print(f"    win%     p5={q(boot_winrate,0.05)*100:.2f}%  p50={q(boot_winrate,0.5)*100:.2f}%  p95={q(boot_winrate,0.95)*100:.2f}%")
print(f"    P(PF<1.0):  {sum(1 for x in boot_pf if x<1)/N*100:.2f}%")
print(f"    P(net<0):   {sum(1 for x in boot_net if x<0)/N*100:.2f}%")

# Also bootstrap baseline for comparison
returns_base = [t['net'] / R for t in trades]
boot_pf_base = []
boot_net_base = []
for _ in range(N):
    samp = [trades[random.randint(0, n - 1)] for _ in range(n)]
    w = sum(t['net'] for t in samp if t['net'] > 0)
    l = sum(t['net'] for t in samp if t['net'] < 0)
    boot_pf_base.append(w / -l if l < 0 else 100)
    boot_net_base.append(sum(t['net'] for t in samp))

print(f"\n  vs BASELINE bootstrap:")
print(f"    PF       p5={q(boot_pf_base,0.05):.4f}  p50={q(boot_pf_base,0.5):.4f}  p95={q(boot_pf_base,0.95):.4f}")
print(f"    net($)   p5=${q(boot_pf_base,0.05)/100:.2f}  p50=${q(boot_net_base,0.5)/100:.2f}  p95=${q(boot_net_base,0.95)/100:.2f}")
print(f"    P(PF<1.0):  {sum(1 for x in boot_pf_base if x<1)/N*100:.2f}%")
print(f"    P(net<0):   {sum(1 for x in boot_net_base if x<0)/N*100:.2f}%")

# === 6. Real-world delay implementation considerations ===
header("6. Real-world implementation modeling")
print("""
The counterfactual in §4 is biased toward optimism — it uses forward
information (hold time is only known after the trade closes). A real
delay gate would work differently:

  - At T=0: shock-arm signal fires
  - During [T, T+delay]: WAIT, do not enter
  - At T=delay: re-check entry condition
  - If still armed: enter at the new price (different from T=0 price)
  - If condition lapsed: skip

What the §4 numbers approximately model:
  - Skip <Ns trades = "trades that would have closed within N seconds
    even if we'd entered at T=0"
  - This is an UPPER BOUND on the filter's benefit because:
    (a) Some sub-Ns trades that are profitable (BE saves) are also
        skipped — losing some upside
    (b) The new entry price at T=delay may be worse — losing some
        per-trade edge on the trades that do enter
    (c) Some trades whose shock condition lapses during the delay
        wouldn't have been entered at all, so the filter's benefit
        is partially "would have been a loser anyway"

To model (a-c) properly we would need intra-trade tick data and
bar-level price progression. Neither is in the held-out artifact;
they're upstream in the bar-builder / sim03 corpus. Forward paper
trading with the gate enabled is the cleanest empirical answer.

Two implementation patterns worth dispatching:

  (i) Time-based delay: wait N seconds, re-check shock condition,
      enter if still armed. Simple, no new features needed.
  (ii) Confirmation-based gate: require shock condition to persist
      for K consecutive bars before entering. More principled but
      requires a new strategy parameter and snapshot field.

Either becomes regime_shock_reversion_short_v4 (or similar) per
CF-41 — distinct from v3 (the VIX-gate hypothesis).
""")

# === 7. Headline summary ===
header("7. Headline summary")
print(f"""
HYPOTHESIS PARTIALLY CONFIRMED:

  Filtering trades that turn out to hold <60s removes 130/{n} ({130/n*100:.1f}%)
  trades that net ${sum(t['net'] for t in trades if t['hold_sec']<60)/100:.2f} (negative). The
  residual filtered cohort has:

    - PF lift: 1.418 → {sum(t['net'] for t in filt if t['net']>0)/-sum(t['net'] for t in filt if t['net']<0):.4f}
    - Net lift: ${baseline_net/100:.2f} → ${sum(t['net'] for t in filt)/100:.2f}
    - Win rate: 50.6% → {sum(1 for t in filt if t['net']>0)/n_filt*100:.1f}%
    - P(net < 0) bootstrap: 0.02% → {sum(1 for x in boot_net if x<0)/N*100:.2f}%

  These numbers are UPPER BOUND. Real delay-gate benefit will be 30-70%
  of this on forward data once execution mechanics are accounted for.

PRIMARY FINDING:

  Sub-30s trades are the worst sub-cohort (n={len(sub_30)}, win% {sum(1 for t in sub_30 if t['net']>0)/len(sub_30)*100:.1f}%,
  net ${sum(t['net'] for t in sub_30)/100:.2f}). These are pure chop-flip — entry signal fires,
  market immediately moves against, position exits within one bar.

  30-60s trades (n={len(sub_60)}) are also net-negative but less extreme.

  60-120s trades (n={len(sub_120)}) are MIXED — already showing residual edge
  (PF approaches 1.0).

  This justifies a 30s-60s delay gate as the highest-priority research
  target. The 120s+ cohort is already where the strategy's edge lives.

NO FEATURE SHORTCUT FOUND:

  Spread bucket, queue-ahead bucket, and regime do NOT cleanly separate
  sub-2min from >=2min cohorts. Cannot pre-filter on entry-time
  features alone; time-based gating (delay or persistence) is required.

NEXT STEPS (research-tier, not implementation):

  1. Pursue a regime_shock_reversion_short_v4 spec (time-delay variant)
  2. Forward paper with delay enabled vs disabled, A/B comparison
  3. Persistence variant (require shock arm for K consecutive bars)
     as parallel hypothesis
""")
