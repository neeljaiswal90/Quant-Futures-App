"""Interactive exploration shell for a single trading day.

Invoke with::

    python -i scripts/explore_session.py 2026-05-15

Pre-populates the following locals so you can immediately poke at a session
without re-running the loader pipeline:

    trades             OBS-01 DataFrame (load_obs01_trades)
    vp                 VolumeProfile (compute_vp with MNQ defaults)
    cvd_df             trades + cvd columns (compute_cvd)
    footprint          Footprint (compute_footprint with 30s/1-tick defaults)
    absorption_events  list[AbsorptionEvent] (compute_absorption_events)
    multi              MultiSessionVP for the trailing 5 sessions, OR None if
                       there aren't enough prior days under data/captures
    envelope           ZoneEnvelope (Phase-1 builder; ATR over 5-min bars)

Missing pieces (e.g. no MBP1 file → no absorption events) become ``None`` /
empty rather than raising. The point is to land in a REPL with a populated
namespace, not to enforce a contract.

Typical follow-ups inside the shell::

    >>> vp.vpoc, vp.vah, vp.val
    >>> [z for z in envelope.zones if z.conviction in ("SUPER", "HIGH")]
    >>> cvd_df["cvd_rth"].iloc[-1]                  # net delta for the day
    >>> footprint.deltas.iloc[-10:].sum()           # last 10 bins' delta
    >>> [e for e in absorption_events if e.confirmed]
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_mbp1, load_obs01_trades
from rithmic_analytics.core.schema import ZoneEnvelope
from rithmic_analytics.features.absorption import (
    apply_next_bar_confirmation,
    compute_absorption_events,
)
from rithmic_analytics.features.atr import NS_5M, compute_atr_from_ticks
from rithmic_analytics.features.cvd import compute_cvd
from rithmic_analytics.features.footprint import compute_footprint
from rithmic_analytics.features.multi_session import aggregate_multi_session
from rithmic_analytics.features.volume_profile import compute_vp

_CAPTURES_ROOT = Path("data/captures")
_ROOT_SYMBOL = "MNQ"
_SESSION = "rth"
_MULTI_LOOKBACK_SESSIONS = 5


def _resolve_trading_date(argv: list[str]) -> date:
    if len(argv) < 2:
        sys.exit("usage: python -i scripts/explore_session.py YYYY-MM-DD")
    try:
        return date.fromisoformat(argv[1])
    except ValueError as exc:
        sys.exit(f"bad trading-date {argv[1]!r}: {exc}")


def _trailing_session_dates(target: date, lookback: int) -> list[date]:
    if not _CAPTURES_ROOT.exists():
        return []
    candidates: list[date] = []
    for day_dir in sorted(_CAPTURES_ROOT.iterdir(), reverse=True):
        if not day_dir.is_dir():
            continue
        try:
            d = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        if d >= target:
            continue
        if (day_dir / f"{_ROOT_SYMBOL}_{_SESSION}.jsonl").exists():
            candidates.append(d)
        if len(candidates) >= lookback:
            break
    return sorted(candidates)


_trading_date = _resolve_trading_date(sys.argv)
_capture_path = _CAPTURES_ROOT / _trading_date.isoformat() / f"{_ROOT_SYMBOL}_{_SESSION}.jsonl"
_mbp1_path = _CAPTURES_ROOT / _trading_date.isoformat() / f"{_ROOT_SYMBOL}_mbp1.jsonl"

if not _capture_path.exists():
    sys.exit(f"no capture at {_capture_path}")

print(f"loading {_capture_path}...")
trades = load_obs01_trades(_capture_path)
print(f"  {len(trades):,} trades")

print("compute_vp...")
vp = compute_vp(trades, MNQ)

print("compute_cvd...")
cvd_df = compute_cvd(trades)

print("compute_footprint...")
footprint = compute_footprint(trades, MNQ)

absorption_events: list = []
if _mbp1_path.exists():
    print(f"absorption (with {_mbp1_path.name})...")
    mbp1 = load_mbp1(_mbp1_path)
    raw = compute_absorption_events(trades, mbp1, MNQ)
    absorption_events = apply_next_bar_confirmation(raw, trades, MNQ)
    _n_conf = sum(1 for e in absorption_events if e.confirmed)
    print(f"  {len(absorption_events)} events ({_n_conf} confirmed)")
else:
    print(f"absorption: skipped (no {_mbp1_path.name})")

multi = None
_prior_dates = _trailing_session_dates(_trading_date, _MULTI_LOOKBACK_SESSIONS)
if len(_prior_dates) >= 2:
    print(f"multi_session ({len(_prior_dates)} prior sessions)...")
    _session_vps = []
    for d in _prior_dates:
        _p = _CAPTURES_ROOT / d.isoformat() / f"{_ROOT_SYMBOL}_{_SESSION}.jsonl"
        _t = load_obs01_trades(_p)
        _session_vps.append((f"mnq-{d.isoformat()}-{_SESSION}", compute_vp(_t, MNQ)))
    multi = aggregate_multi_session(_session_vps)
else:
    print("multi_session: skipped (need ≥2 prior sessions)")

print("envelope...")
_atr_14 = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
envelope = ZoneEnvelope.from_volume_profile(
    vp,
    symbol=_ROOT_SYMBOL,
    timeframe=_SESSION,
    atr_14=_atr_14,
    data_source="rithmic",
    bin_size_ticks=20,
    bars_used=len(trades),
)

print()
print(envelope.summary_line())
print()
print("Locals ready: trades, vp, cvd_df, footprint, absorption_events, multi, envelope")
