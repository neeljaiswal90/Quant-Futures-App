"""Golden-file parity test for RA-029 probe normalizer.

Feeds the validated 4.1 GB probe-parity capture through
:func:`normalize_probe_to_obs01` and diffs the first 1000 trade records
against the validated OBS-01 fixture. Schema fields must match exactly;
floating-point prices compared at full precision.

Marked ``@pytest.mark.slow`` since it touches multi-GB files and runs in
~30-60s. Self-skips when the fixture isn't available (e.g., fresh checkout
without the validated fixtures on disk).

The fixtures live outside the analytics tree at:
    D:/Quant-futures-app/data/probes/infra01/full/
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_analytics.ops.normalize_probe import normalize_probe_to_obs01

# Fixtures (paired — same capture, two representations)
_PARITY_FIXTURE = Path(
    "D:/Quant-futures-app/data/probes/infra01/full/probe-parity-post04d.jsonl"
)
_OBS01_FIXTURE = Path(
    "D:/Quant-futures-app/data/probes/infra01/full/l1-trade-post04d.obs01.jsonl"
)
_GOLDEN_TRADE_COUNT = 1000
# Fields where the value MUST match exactly between normalizer output and
# the validated OBS-01 fixture. Excludes `event_id` and `run_id`, which
# are synthetic per-run identifiers.
_PAYLOAD_FIELDS = (
    "aggressor_side", "exchange_event_ts_ns", "price", "quantity",
    "sidecar_recv_ts_ns", "trade_id",
)
_ENVELOPE_FIELDS = ("session_id", "type", "ts_ns", "schema_version")


@pytest.mark.slow
def test_normalizer_matches_validated_obs01_fixture_first_1000_trades(
    tmp_path: Path,
) -> None:
    """Golden-file parity: normalize → diff against existing OBS-01 fixture."""
    if not _PARITY_FIXTURE.exists():
        pytest.skip(f"parity fixture not on disk: {_PARITY_FIXTURE}")
    if not _OBS01_FIXTURE.exists():
        pytest.skip(f"OBS-01 fixture not on disk: {_OBS01_FIXTURE}")

    # The validated fixture uses session_id "mnq-2026-04-27-rth" and
    # run_id "rithmic-post04d-full". Pass both explicitly so the
    # session_id field matches byte-for-byte.
    out_path = tmp_path / "MNQ_rth.obs01.jsonl"
    normalize_probe_to_obs01(
        _PARITY_FIXTURE, out_path,
        session_id="mnq-2026-04-27-rth",
        run_id="rithmic-post04d-full",
    )

    # Load first 1000 records from the normalized output. By construction
    # the normalizer emits ONLY type="TRADE" envelopes.
    with out_path.open("r", encoding="utf-8") as f:
        normalized_first_1000 = [json.loads(next(f)) for _ in range(_GOLDEN_TRADE_COUNT)]

    # The validated OBS-01 fixture is a SUPERSET — it also contains
    # type="QUOTE" envelopes interleaved with TRADEs. Filter to TRADEs
    # before slicing so the comparison is apples-to-apples.
    validated_first_1000: list[dict[str, object]] = []
    with _OBS01_FIXTURE.open("r", encoding="utf-8") as f:
        for line in f:
            rec: dict[str, object] = json.loads(line)
            if rec.get("type") != "TRADE":
                continue
            validated_first_1000.append(rec)
            if len(validated_first_1000) >= _GOLDEN_TRADE_COUNT:
                break

    assert len(validated_first_1000) == _GOLDEN_TRADE_COUNT, (
        f"validated fixture had fewer than {_GOLDEN_TRADE_COUNT} TRADE records"
    )

    mismatches: list[str] = []
    for i, (norm, valid) in enumerate(zip(normalized_first_1000, validated_first_1000, strict=True)):
        # Envelope fields
        for fld in _ENVELOPE_FIELDS:
            if norm.get(fld) != valid.get(fld):
                mismatches.append(
                    f"record {i}: envelope.{fld} differs — "
                    f"normalized={norm.get(fld)!r} validated={valid.get(fld)!r}"
                )
        # Payload fields — exact match at full float precision
        norm_payload_raw = norm.get("payload")
        valid_payload_raw = valid.get("payload")
        norm_payload: dict[str, object] = (
            norm_payload_raw if isinstance(norm_payload_raw, dict) else {}
        )
        valid_payload: dict[str, object] = (
            valid_payload_raw if isinstance(valid_payload_raw, dict) else {}
        )
        for fld in _PAYLOAD_FIELDS:
            if norm_payload.get(fld) != valid_payload.get(fld):
                mismatches.append(
                    f"record {i}: payload.{fld} differs — "
                    f"normalized={norm_payload.get(fld)!r} "
                    f"validated={valid_payload.get(fld)!r}"
                )
        if len(mismatches) > 20:
            # Cap the diff output so failures don't flood stderr
            mismatches.append("... more mismatches truncated")
            break

    assert not mismatches, "\n".join(mismatches[:25])


@pytest.mark.slow
def test_normalizer_output_loadable_by_obs01_loader_at_scale(tmp_path: Path) -> None:
    """The normalized full-fixture output is consumable by load_obs01_trades."""
    if not _PARITY_FIXTURE.exists():
        pytest.skip(f"parity fixture not on disk: {_PARITY_FIXTURE}")

    out_path = tmp_path / "MNQ_rth.obs01.jsonl"
    report = normalize_probe_to_obs01(
        _PARITY_FIXTURE, out_path,
        session_id="mnq-2026-04-27-rth",
        run_id="rithmic-post04d-full",
    )

    assert report.trades_emitted > 0

    # Load just the head of the file (use the loader, which streams).
    # We don't want to hold the full ~36 MB OBS-01 in test memory unless
    # necessary — `load_obs01_trades` is already validated at 100K+ rows
    # in other tests. Here we just confirm shape compatibility.
    from rithmic_analytics.core.loader import load_obs01_trades
    df = load_obs01_trades(out_path)
    assert len(df) == report.trades_emitted
    assert "event_ts_ns" in df.columns
    assert "price" in df.columns
    assert "signed_qty" in df.columns
