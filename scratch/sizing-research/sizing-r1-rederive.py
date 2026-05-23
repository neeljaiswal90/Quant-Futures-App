"""SIZING-R1: re-derive Kelly + tiered-sizing analysis on post-fix Cycle3.

Substrate:
  artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json
  (post QFA-MGMT-BUG-FIX-01; commit 86dc5ec; fingerprint ede3b8d5...)

Outputs printed to stdout (memo extracts these into docs/research/sizing-r1-*.md).
Not part of any byte-equality contract; research-tier scratch only.
"""
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

random.seed(20260524)

ARTIFACT = 'artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json'

with open(ARTIFACT) as f:
    d = json.load(f)

trades = d['trades']
for t in trades:
    for k in ['net_pnl_cents', 'gross_pnl_cents', 'max_adverse_excursion_cents',
              'max_favorable_excursion_cents', 'entry_ts_ns', 'exit_ts_ns']:
        t[k] = int(t[k])
    t['entry_dt'] = datetime.fromtimestamp(t['entry_ts_ns'] / 1e9, tz=timezone.utc)


def header(t):
    print(f"\n{'=' * 72}\n{t}\n{'=' * 72}")


header(f"SIZING-R1 substrate: post-fix Cycle3 (fingerprint {d['strategy_fingerprint_sha256'][:16]}...)")
n = len(trades)
sl = [t for t in trades if t['exit_reason'] == 'stop_loss']
R = -sum(t['net_pnl_cents'] for t in sl) / len(sl)
for t in trades:
    t['R'] = t['net_pnl_cents'] / R

wins = [t['R'] for t in trades if t['R'] > 0]
losses = [t['R'] for t in trades if t['R'] < 0]
p = len(wins) / n
avg_w = sum(wins) / len(wins)
avg_l = abs(sum(losses) / len(losses))
b = avg_w / avg_l
mean_R = sum(t['R'] for t in trades) / n
var_R = sum((t['R'] - mean_R) ** 2 for t in trades) / n

print(f"Trades: {n}, R unit: ${R/100:.2f} (avg stop-loss net)")
print(f"Wins: {len(wins)} ({p*100:.2f}%), Losses: {len(losses)}")
print(f"Avg win: {avg_w:.4f}R, avg loss: {avg_l:.4f}R, b = {b:.4f}")
print(f"E[R] = {mean_R:.4f}, Std[R] = {math.sqrt(var_R):.4f}")
print(f"PF (aggregate): {d['aggregate']['profit_factor_ppm']/1_000_000:.4f}")


header("Classic (binary) Kelly")
classic = (p * b - (1 - p)) / b
print(f"f* = (p*b - q)/b = ({p:.4f}*{b:.4f} - {1-p:.4f}) / {b:.4f}")
print(f"f* = {classic*100:.3f}% of equity risked per trade")
print(f"Operator's back-of-envelope: ~16.5% (using rough b ≈ 1.45)")
print(f"This computation: classic={classic*100:.3f}%, b_actual={b:.4f}")


header("Generalized (log-utility) Kelly via golden-section search")


def kelly_gss(xs, lo=0.0, hi=0.6, tol=1e-5):
    def f_obj(f):
        s = 0.0
        for r in xs:
            v = 1 + f * r
            if v <= 0:
                return -1e18
            s += math.log(v)
        return s
    phi = (1 + 5 ** 0.5) / 2
    invphi = 1 / phi
    a, b_ = lo, hi
    c = b_ - (b_ - a) * invphi
    dd = a + (b_ - a) * invphi
    while (b_ - a) > tol:
        if f_obj(c) > f_obj(dd):
            b_ = dd
        else:
            a = c
        c = b_ - (b_ - a) * invphi
        dd = a + (b_ - a) * invphi
    return (a + b_) / 2


returns = [t['R'] for t in trades]
f_gen = kelly_gss(returns)
print(f"Generalized Kelly f*: {f_gen*100:.3f}%")


def simulate(f, rs):
    eq = 1.0
    peak = 1.0
    dd = 0.0
    for r in rs:
        eq *= (1 + f * r)
        if eq <= 0:
            return None, None, None
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak)
    return eq, dd, eq ** (1 / len(rs)) - 1


header("Fixed-fraction sizing simulation on $50k account, sorted chronologically")
trades_sorted = sorted(trades, key=lambda t: t['entry_ts_ns'])
ret_sorted = [t['R'] for t in trades_sorted]
print(f"  {'f%':>6}  {'contracts':>9}  {'final $':>13}  {'CAGR (3mo)':>11}  {'maxDD%':>7}  {'maxDD$':>10}")
EQUITY0 = 50_000_00
for f in [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10, 0.165, 0.20, 0.25]:
    eq, dd, geo = simulate(f, ret_sorted)
    if eq is None:
        print(f"  {f*100:5.2f}%  RUIN")
        continue
    risk = f * EQUITY0
    ctr = risk / R
    print(f"  {f*100:5.2f}% {ctr:10.1f} ${eq*EQUITY0/100:12,.0f}  {(eq-1)*100:10.1f}%  {dd*100:6.2f}% ${dd*EQUITY0/100:9,.0f}")


header("Bootstrap CI (N=5000, i.i.d. + block-20)")


def classic_kelly_dollars(xs):
    w = [x for x in xs if x > 0]
    l = [x for x in xs if x < 0]
    if not w or not l:
        return 0.0
    pp = len(w) / len(xs)
    bb = (sum(w) / len(w)) / (-sum(l) / len(l))
    return (pp * bb - (1 - pp)) / bb if bb > 0 else 0


def block_bs(xs, sz=20):
    out = []
    while len(out) < len(xs):
        s = random.randint(0, len(xs) - 1)
        out.extend(xs[s:s + sz])
    return out[:len(xs)]


N = 5000
boot_iid_pf, boot_iid_net, boot_iid_kelly, boot_iid_gen = [], [], [], []
boot_blk_pf, boot_blk_net = [], []

for _ in range(N):
    s = [returns[random.randint(0, n - 1)] for _ in range(n)]
    wp = sum(x for x in s if x > 0)
    lp = sum(x for x in s if x < 0)
    boot_iid_pf.append(wp / -lp if lp < 0 else (100 if wp > 0 else 1))
    boot_iid_net.append(sum(s))
    boot_iid_kelly.append(classic_kelly_dollars(s))
    boot_iid_gen.append(kelly_gss(s))

for _ in range(N):
    s = block_bs(returns, 20)
    wp = sum(x for x in s if x > 0)
    lp = sum(x for x in s if x < 0)
    boot_blk_pf.append(wp / -lp if lp < 0 else (100 if wp > 0 else 1))
    boot_blk_net.append(sum(s))


def q(xs, p_):
    s = sorted(xs)
    k = (len(s) - 1) * p_
    f_ = int(k)
    c = min(f_ + 1, len(s) - 1)
    return s[f_] if f_ == c else s[f_] + (s[c] - s[f_]) * (k - f_)


print(f"  {'metric':<28} {'point':>10} {'p5':>10} {'p50':>10} {'p95':>10}")
print(f"  {'PF (i.i.d.)':<28} {d['aggregate']['profit_factor_ppm']/1_000_000:10.4f} {q(boot_iid_pf,0.05):10.4f} {q(boot_iid_pf,0.5):10.4f} {q(boot_iid_pf,0.95):10.4f}")
print(f"  {'PF (block-20)':<28} {d['aggregate']['profit_factor_ppm']/1_000_000:10.4f} {q(boot_blk_pf,0.05):10.4f} {q(boot_blk_pf,0.5):10.4f} {q(boot_blk_pf,0.95):10.4f}")
print(f"  {'classic Kelly':<28} {classic:10.4f} {q(boot_iid_kelly,0.05):10.4f} {q(boot_iid_kelly,0.5):10.4f} {q(boot_iid_kelly,0.95):10.4f}")
print(f"  {'generalized Kelly':<28} {f_gen:10.4f} {q(boot_iid_gen,0.05):10.4f} {q(boot_iid_gen,0.5):10.4f} {q(boot_iid_gen,0.95):10.4f}")

print(f"\n  P(PF < 1.0)         iid: {sum(1 for x in boot_iid_pf if x<1)/N*100:5.2f}%")
print(f"  P(PF < 1.0)       block: {sum(1 for x in boot_blk_pf if x<1)/N*100:5.2f}%")
print(f"  P(net < 0)          iid: {sum(1 for x in boot_iid_net if x<0)/N*100:5.2f}%")
print(f"  P(net < 0)        block: {sum(1 for x in boot_blk_net if x<0)/N*100:5.2f}%")
print(f"  P(classic Kelly < 0):     {sum(1 for x in boot_iid_kelly if x<0)/N*100:5.2f}%")
print(f"  P(classic Kelly < 5%):    {sum(1 for x in boot_iid_kelly if x<0.05)/N*100:5.2f}%")
print(f"  P(generalized < 5%):      {sum(1 for x in boot_iid_gen if x<0.05)/N*100:5.2f}%")
print(f"\n  Honest sizing ceiling (5th pct generalized): {q(boot_iid_gen, 0.05)*100:.3f}%")
print(f"  ~half of point estimate:                      {f_gen/2*100:.3f}%")
print(f"  ~quarter of point estimate:                   {f_gen/4*100:.3f}%")


header("Time-of-day tier analysis (UTC entry hour)")


def tier(t):
    h = t['entry_dt'].hour
    if h <= 14:
        return 'A_open'
    if h == 15:
        return 'B_morning'
    if h <= 17:
        return 'C_late_am'
    if h <= 19:
        return 'D_afternoon'
    return 'E_close'


for t in trades_sorted:
    t['tier'] = tier(t)

tier_kelly = {}
tier_rows = []
for ti in ['A_open', 'B_morning', 'C_late_am', 'D_afternoon', 'E_close']:
    sub = [t for t in trades_sorted if t['tier'] == ti]
    if not sub:
        continue
    rs = [t['R'] for t in sub]
    w = [r for r in rs if r > 0]
    l = [r for r in rs if r < 0]
    pf_t = sum(w) / -sum(l) if l else float('inf')
    mean_t = sum(rs) / len(rs)
    f_t = kelly_gss(rs)
    tier_kelly[ti] = f_t
    pf_s = f"{pf_t:6.3f}" if pf_t != float('inf') else "   inf"
    tier_rows.append((ti, len(sub), len(w) / len(rs) * 100, pf_t, mean_t, f_t))
    print(f"  {ti:<14} n={len(sub):4d}  win%={len(w)/len(rs)*100:5.1f}  PF={pf_s}  E[R]={mean_t:6.3f}  tier f*={f_t*100:7.2f}%")


header("Tiered sizing simulations on $50k account")


def simulate_tiered(tier_f, ret_with_tier):
    eq = 1.0
    peak = 1.0
    dd = 0.0
    for r, ti in ret_with_tier:
        f = tier_f.get(ti, 0)
        eq *= (1 + f * r)
        if eq <= 0:
            return None, None, None
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak)
    return eq, dd, eq ** (1 / len(ret_with_tier)) - 1


ret_tier = [(t['R'], t['tier']) for t in trades_sorted]
mean_tier_f = sum(tier_kelly.values()) / len(tier_kelly)

schemes = [
    ("flat 1% (no tiering)", {ti: 0.01 for ti in tier_kelly}),
    ("flat 2% (no tiering)", {ti: 0.02 for ti in tier_kelly}),
    ("per-tier quarter-Kelly", {ti: v / 4 for ti, v in tier_kelly.items()}),
    ("per-tier half-Kelly", {ti: v / 2 for ti, v in tier_kelly.items()}),
    ("1% × (tier_f / mean_tier_f)", {ti: 0.01 * (v / mean_tier_f) for ti, v in tier_kelly.items()}),
    ("2% × (tier_f / mean_tier_f)", {ti: 0.02 * (v / mean_tier_f) for ti, v in tier_kelly.items()}),
]
print(f"  {'scheme':<40}  {'final $':>14}  {'CAGR':>9}  {'maxDD%':>7}")
for name, sch in schemes:
    eq, dd, geo = simulate_tiered(sch, ret_tier)
    if eq is None:
        print(f"  {name:<40}  RUIN")
        continue
    print(f"  {name:<40}  ${eq*50_000:13,.0f}  {(eq-1)*100:8.1f}%  {dd*100:6.2f}%")


header("Pre-fix → post-fix headline shift")
print("                          PRE-FIX (528 trades)    POST-FIX (571 trades)   Δ")
print(f"  Win rate                  39.77%                  50.61%                  +10.84pp")
print(f"  PF                        1.395                   1.418                   +0.023")
print(f"  Avg win                   2.107R ($33.57)         {avg_w:.3f}R (${avg_w*R/100:.2f})         {(avg_w-2.107):+.3f}R")
print(f"  Avg loss                  0.997R ($15.89)         {avg_l:.3f}R (${avg_l*R/100:.2f})         {(avg_l-0.997):+.3f}R")
print(f"  b (win/loss ratio)        2.113                   {b:.3f}                   {b-2.113:+.3f}")
print(f"  E[R]                      0.237R                  {mean_R:.3f}R                  {mean_R-0.237:+.3f}R")
print(f"  Std[R]                    1.603R                  {math.sqrt(var_R):.3f}R                  {math.sqrt(var_R)-1.603:+.3f}R")
print(f"  Classic Kelly             11.26%                  {classic*100:.2f}%                  {(classic-0.1126)*100:+.2f}pp")
print(f"  Generalized Kelly         10.29%                  {f_gen*100:.2f}%                  {(f_gen-0.1029)*100:+.2f}pp")
