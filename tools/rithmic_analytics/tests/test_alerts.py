"""Tests for ``rithmic_analytics.ops.alerts``."""

from __future__ import annotations

import dataclasses
import json
import urllib.error
from pathlib import Path
from typing import Any

import pytest

from rithmic_analytics.ops.alerts import (
    Gap,
    GapThresholds,
    analyze_mbp1_quote_gaps,
    analyze_obs01_trade_gaps,
    emit_alerts,
    send_discord_webhook,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _write_obs01_at_times(path: Path, ts_ns_list: list[int]) -> None:
    """Write an OBS-01 JSONL with TRADE envelopes at the given timestamps."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for i, ts_ns in enumerate(ts_ns_list):
            rec: dict[str, Any] = {
                "event_id": f"trade-{i:06d}",
                "run_id": "alerts-test",
                "schema_version": 1,
                "session_id": "mnq-2026-05-15-rth",
                "ts_ns": str(ts_ns),
                "type": "TRADE",
                "payload": {
                    "aggressor_side": "buy",
                    "exchange_event_ts_ns": str(ts_ns),
                    "sidecar_recv_ts_ns": str(ts_ns + 1000),
                    "price": 27380.0,
                    "quantity": 1,
                    "trade_id": f"t{i}",
                },
            }
            f.write(json.dumps(rec) + "\n")


def _write_mbp1_at_times(path: Path, ts_ns_list: list[int]) -> None:
    """Write an MBP1 JSONL with quote rows at the given timestamps."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ts_ns in ts_ns_list:
            rec: dict[str, Any] = {
                "ts_event_ns": str(ts_ns),
                "ts_recv_ns": str(ts_ns + 1000),
                "bid_px_00": 27371.25,
                "bid_sz_00": 6,
                "bid_ct_00": 6,
                "ask_px_00": 27371.75,
                "ask_sz_00": 8,
                "ask_ct_00": 8,
            }
            f.write(json.dumps(rec) + "\n")


_BASE_TS_NS = 1_777_301_400_000_000_000  # arbitrary recent ns timestamp


# ---------------------------------------------------------------------------
# OBS-01 trade gap detection
# ---------------------------------------------------------------------------


def test_obs01_no_gaps_when_trades_within_threshold(tmp_path: Path) -> None:
    # 100 trades 1 second apart — well under 60s warn threshold.
    path = tmp_path / "obs01.jsonl"
    _write_obs01_at_times(path, [_BASE_TS_NS + i * 1_000_000_000 for i in range(100)])

    gaps = analyze_obs01_trade_gaps(path)

    assert gaps == []


def test_obs01_70sec_trade_gap_emits_warn(tmp_path: Path) -> None:
    # Two trades 70 seconds apart → WARN (above 60s warning, below 300s fail).
    path = tmp_path / "obs01.jsonl"
    _write_obs01_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 70 * 1_000_000_000])

    gaps = analyze_obs01_trade_gaps(path)

    assert len(gaps) == 1
    assert gaps[0].stream == "LAST_TRADE"
    assert gaps[0].severity == "WARN"
    assert gaps[0].gap_ms == pytest.approx(70_000.0)
    assert gaps[0].threshold_ms == 60_000
    assert gaps[0].session_id == "mnq-2026-05-15-rth"


def test_obs01_6min_trade_gap_emits_fail(tmp_path: Path) -> None:
    # 360-second gap → above 300s fail threshold.
    path = tmp_path / "obs01.jsonl"
    _write_obs01_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 360 * 1_000_000_000])

    gaps = analyze_obs01_trade_gaps(path)

    assert len(gaps) == 1
    assert gaps[0].severity == "FAIL"
    assert gaps[0].threshold_ms == 300_000


def test_obs01_just_under_60s_no_alert(tmp_path: Path) -> None:
    # 59-second gap — below warn threshold, no alert.
    path = tmp_path / "obs01.jsonl"
    _write_obs01_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 59 * 1_000_000_000])

    gaps = analyze_obs01_trade_gaps(path)

    assert gaps == []


def test_obs01_multiple_gaps_all_emitted(tmp_path: Path) -> None:
    # Three intervals: 70s (WARN), 5s (no alert), 400s (FAIL).
    path = tmp_path / "obs01.jsonl"
    ts = [
        _BASE_TS_NS,
        _BASE_TS_NS + 70 * 1_000_000_000,
        _BASE_TS_NS + 75 * 1_000_000_000,
        _BASE_TS_NS + 475 * 1_000_000_000,
    ]
    _write_obs01_at_times(path, ts)

    gaps = analyze_obs01_trade_gaps(path)

    assert len(gaps) == 2
    assert gaps[0].severity == "WARN"
    assert gaps[1].severity == "FAIL"


def test_obs01_empty_file_returns_no_gaps(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    path.touch()
    assert analyze_obs01_trade_gaps(path) == []


def test_obs01_missing_file_returns_no_gaps(tmp_path: Path) -> None:
    assert analyze_obs01_trade_gaps(tmp_path / "nonexistent.jsonl") == []


def test_obs01_quote_envelopes_skipped(tmp_path: Path) -> None:
    # Mix of TRADE and QUOTE envelopes with the QUOTEs at intermediate timestamps —
    # gaps should be computed only between TRADE events.
    path = tmp_path / "obs01.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for i, (ts_ns, type_) in enumerate(
            [
                (_BASE_TS_NS, "TRADE"),
                (_BASE_TS_NS + 30 * 1_000_000_000, "QUOTE"),  # skipped
                (_BASE_TS_NS + 70 * 1_000_000_000, "TRADE"),  # 70s gap from prev TRADE
            ]
        ):
            rec = {
                "event_id": f"e{i}",
                "run_id": "test",
                "schema_version": 1,
                "session_id": "mnq-2026-05-15-rth",
                "ts_ns": str(ts_ns),
                "type": type_,
                "payload": {
                    "aggressor_side": "buy",
                    "exchange_event_ts_ns": str(ts_ns),
                    "sidecar_recv_ts_ns": str(ts_ns + 1000),
                    "price": 27380.0,
                    "quantity": 1,
                    "trade_id": f"t{i}",
                },
            }
            f.write(json.dumps(rec) + "\n")

    gaps = analyze_obs01_trade_gaps(path)

    assert len(gaps) == 1
    assert gaps[0].severity == "WARN"


def test_obs01_custom_thresholds(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    _write_obs01_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 10 * 1_000_000_000])

    # With a 5-second warn threshold, a 10s gap fires WARN.
    gaps = analyze_obs01_trade_gaps(
        path, thresholds=GapThresholds(last_trade_warning_ms=5_000)
    )

    assert len(gaps) == 1
    assert gaps[0].severity == "WARN"
    assert gaps[0].threshold_ms == 5_000


# ---------------------------------------------------------------------------
# MBP1 quote gap detection
# ---------------------------------------------------------------------------


def test_mbp1_2sec_quote_gap_emits_warn(tmp_path: Path) -> None:
    # Verbatim from RA-009 v2 acceptance: 2-second L1 gap → 1 WARN alert.
    path = tmp_path / "mbp1.jsonl"
    _write_mbp1_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 2 * 1_000_000_000])

    gaps = analyze_mbp1_quote_gaps(path, session_id="mnq-2026-05-15-rth")

    assert len(gaps) == 1
    assert gaps[0].stream == "L1_QUOTE"
    assert gaps[0].severity == "WARN"
    assert gaps[0].gap_ms == pytest.approx(2_000.0)
    assert gaps[0].threshold_ms == 1_000
    assert gaps[0].session_id == "mnq-2026-05-15-rth"


def test_mbp1_6sec_quote_gap_emits_fail(tmp_path: Path) -> None:
    path = tmp_path / "mbp1.jsonl"
    _write_mbp1_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 6 * 1_000_000_000])

    gaps = analyze_mbp1_quote_gaps(path, session_id="mnq-2026-05-15-rth")

    assert len(gaps) == 1
    assert gaps[0].severity == "FAIL"
    assert gaps[0].threshold_ms == 5_000


def test_mbp1_999ms_no_alert(tmp_path: Path) -> None:
    # Just below the 1s warn threshold.
    path = tmp_path / "mbp1.jsonl"
    _write_mbp1_at_times(path, [_BASE_TS_NS, _BASE_TS_NS + 999_000_000])

    gaps = analyze_mbp1_quote_gaps(path, session_id="mnq-2026-05-15-rth")

    assert gaps == []


def test_mbp1_empty_file_returns_no_gaps(tmp_path: Path) -> None:
    path = tmp_path / "mbp1.jsonl"
    path.touch()
    assert analyze_mbp1_quote_gaps(path, session_id="x") == []


# ---------------------------------------------------------------------------
# emit_alerts NDJSON
# ---------------------------------------------------------------------------


def test_emit_alerts_appends_one_line_per_gap(tmp_path: Path) -> None:
    alerts_path = tmp_path / "data" / "alerts" / "alerts.ndjson"
    gaps = [
        Gap(
            stream="LAST_TRADE",
            session_id="mnq-2026-05-15-rth",
            prev_event_ts_ns=_BASE_TS_NS,
            curr_event_ts_ns=_BASE_TS_NS + 70 * 1_000_000_000,
            gap_ms=70_000.0,
            severity="WARN",
            threshold_ms=60_000,
        )
    ]

    written = emit_alerts(gaps, alerts_path, ts_iso="2026-05-15T19:30:00+00:00")

    assert written == 1
    assert alerts_path.exists()
    lines = alerts_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    # All 7 spec'd fields present
    assert parsed["ts_iso"] == "2026-05-15T19:30:00+00:00"
    assert parsed["session_id"] == "mnq-2026-05-15-rth"
    assert parsed["stream"] == "LAST_TRADE"
    assert parsed["gap_type"] == "time"
    assert parsed["gap_value_ns"] == 70 * 1_000_000_000
    assert parsed["threshold_ns"] == 60 * 1_000_000_000
    assert parsed["severity"] == "WARN"


def test_emit_alerts_append_mode_preserves_existing(tmp_path: Path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    alerts_path.parent.mkdir(parents=True, exist_ok=True)
    alerts_path.write_text(
        '{"ts_iso":"2026-05-14T00:00:00+00:00","prior":true}\n', encoding="utf-8"
    )

    gaps = [
        Gap(
            stream="L1_QUOTE",
            session_id="x",
            prev_event_ts_ns=0,
            curr_event_ts_ns=2_000_000_000,
            gap_ms=2_000.0,
            severity="WARN",
            threshold_ms=1_000,
        )
    ]
    emit_alerts(gaps, alerts_path, ts_iso="2026-05-15T19:30:00+00:00")

    lines = alerts_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["prior"] is True
    assert json.loads(lines[1])["stream"] == "L1_QUOTE"


def test_emit_alerts_creates_parent_dir(tmp_path: Path) -> None:
    alerts_path = tmp_path / "deeply" / "nested" / "alerts.ndjson"
    assert not alerts_path.parent.exists()

    gaps = [
        Gap(
            stream="LAST_TRADE",
            session_id="x",
            prev_event_ts_ns=0,
            curr_event_ts_ns=70_000_000_000,
            gap_ms=70_000.0,
            severity="WARN",
            threshold_ms=60_000,
        )
    ]
    written = emit_alerts(gaps, alerts_path)

    assert written == 1
    assert alerts_path.exists()


def test_emit_alerts_empty_list_no_file_written(tmp_path: Path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    written = emit_alerts([], alerts_path)
    assert written == 0
    assert not alerts_path.exists()


def test_emit_alerts_all_lines_are_valid_json(tmp_path: Path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    gaps = [
        Gap(
            stream="LAST_TRADE",
            session_id=f"s{i}",
            prev_event_ts_ns=i * 1_000_000_000,
            curr_event_ts_ns=(i + 70) * 1_000_000_000,
            gap_ms=70_000.0,
            severity="WARN",
            threshold_ms=60_000,
        )
        for i in range(5)
    ]
    emit_alerts(gaps, alerts_path)

    lines = alerts_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 5
    for line in lines:
        json.loads(line)  # raises if invalid


# ---------------------------------------------------------------------------
# Discord webhook
# ---------------------------------------------------------------------------


def test_webhook_called_when_gaps_present(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[Any] = []

    class _FakeResp:
        def __enter__(self) -> Any:
            return self

        def __exit__(self, *args: Any) -> None:  # noqa: ANN401
            pass

        def read(self) -> bytes:
            return b""

    def _fake_urlopen(req: Any, timeout: float = 10) -> Any:  # noqa: ARG001
        captured.append(req)
        return _FakeResp()

    monkeypatch.setattr("rithmic_analytics.ops.alerts.urllib.request.urlopen", _fake_urlopen)

    gaps = [
        Gap(
            stream="LAST_TRADE",
            session_id="mnq-2026-05-15-rth",
            prev_event_ts_ns=0,
            curr_event_ts_ns=70_000_000_000,
            gap_ms=70_000.0,
            severity="WARN",
            threshold_ms=60_000,
        )
    ]
    send_discord_webhook("https://discord.example/webhook", gaps)

    assert len(captured) == 1
    req = captured[0]
    assert req.full_url == "https://discord.example/webhook"
    body = json.loads(req.data.decode("utf-8"))
    assert "content" in body
    assert "FAIL" in body["content"] or "WARN" in body["content"]


def test_webhook_skipped_when_no_gaps(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def _fake_urlopen(req: Any, timeout: float = 10) -> Any:  # noqa: ARG001, ANN401
        nonlocal called
        called = True
        raise AssertionError("should not be called for empty gap list")

    monkeypatch.setattr("rithmic_analytics.ops.alerts.urllib.request.urlopen", _fake_urlopen)

    send_discord_webhook("https://discord.example/webhook", [])

    assert called is False


def test_webhook_failure_logged_not_raised(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def _failing_urlopen(req: Any, timeout: float = 10) -> Any:  # noqa: ARG001, ANN401
        raise urllib.error.URLError("simulated network down")

    monkeypatch.setattr(
        "rithmic_analytics.ops.alerts.urllib.request.urlopen", _failing_urlopen
    )

    gaps = [
        Gap(
            stream="LAST_TRADE",
            session_id="x",
            prev_event_ts_ns=0,
            curr_event_ts_ns=70_000_000_000,
            gap_ms=70_000.0,
            severity="WARN",
            threshold_ms=60_000,
        )
    ]

    with caplog.at_level("ERROR"):
        # Must not raise — alerting failure can't abort the host.
        send_discord_webhook("https://discord.example/webhook", gaps)

    assert any("discord webhook failed" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Dataclass safety
# ---------------------------------------------------------------------------


def test_gap_dataclass_is_frozen() -> None:
    g = Gap(
        stream="LAST_TRADE",
        session_id="x",
        prev_event_ts_ns=0,
        curr_event_ts_ns=1,
        gap_ms=0.001,
        severity="WARN",
        threshold_ms=60_000,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        g.severity = "FAIL"  # type: ignore[misc]


def test_gap_thresholds_defaults_match_qfa() -> None:
    # Cross-reference with services/market_data_sidecar/gap_detection.py defaults.
    # If QFA's source-of-truth changes, this test surfaces the drift.
    t = GapThresholds()
    assert t.l1_quote_warning_ms == 1_000
    assert t.l1_quote_fail_ms == 5_000
    assert t.last_trade_warning_ms == 60_000
    assert t.last_trade_fail_ms == 300_000


def test_gap_thresholds_is_frozen() -> None:
    t = GapThresholds()
    with pytest.raises(dataclasses.FrozenInstanceError):
        t.last_trade_warning_ms = 99  # type: ignore[misc]


# ===========================================================================
# RA-032: FAIL push notifications (post_fail + post_digest)
# ===========================================================================


import logging as _logging  # noqa: E402

from rithmic_analytics.ops import alerts as alerts_mod  # noqa: E402
from rithmic_analytics.ops.alerts import post_digest, post_fail  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_no_webhook_warned() -> None:
    """Reset the once-per-process warning flag between tests."""
    alerts_mod._NO_WEBHOOK_WARNED = False


@pytest.fixture
def _capture_posts(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace _post_discord with a recording stub."""
    posted: list[tuple[str, str]] = []

    def fake_post(url: str, content: str) -> None:
        posted.append((url, content))

    monkeypatch.setattr(alerts_mod, "_post_discord", fake_post)
    return posted


def test_post_fail_missing_env_var_returns_false_and_logs_once(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
) -> None:
    """Missing RITHMIC_DISCORD_WEBHOOK_URL → INFO log on first call, then silent."""
    monkeypatch.delenv("RITHMIC_DISCORD_WEBHOOK_URL", raising=False)

    with caplog.at_level(_logging.INFO, logger="rithmic_analytics.alerts"):
        result1 = post_fail(
            source_name="x", message="msg",
            state_path=tmp_path / "state.json",
        )
        result2 = post_fail(
            source_name="y", message="msg",
            state_path=tmp_path / "state.json",
        )

    assert result1 is False
    assert result2 is False
    # INFO log fires exactly once
    info_lines = [r for r in caplog.records if "not set" in r.message]
    assert len(info_lines) == 1


def test_post_fail_with_webhook_posts_once(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")

    result = post_fail(
        source_name="heartbeat_watchdog", message="missing 2026-05-19.txt",
        state_path=tmp_path / "state.json",
    )

    assert result is True
    assert len(_capture_posts) == 1
    url, content = _capture_posts[0]
    assert url == "https://discord/test"
    assert "heartbeat_watchdog" in content
    assert "missing 2026-05-19.txt" in content


def test_post_fail_dedupes_within_ttl(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    """Second identical FAIL within 30 min is suppressed."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")
    state = tmp_path / "state.json"

    r1 = post_fail(source_name="x", message="m1", state_path=state, now_ts=1_000_000.0)
    r2 = post_fail(source_name="x", message="m2", state_path=state, now_ts=1_000_500.0)

    assert r1 is True
    assert r2 is False  # suppressed
    assert len(_capture_posts) == 1


def test_post_fail_fires_after_ttl_elapses(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    """After 30 min + 1s, the next FAIL with the same source posts again."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")
    state = tmp_path / "state.json"

    post_fail(source_name="x", message="m1", state_path=state, now_ts=1_000_000.0)
    r2 = post_fail(
        source_name="x", message="m2", state_path=state,
        now_ts=1_000_000.0 + 30 * 60 + 1,
    )

    assert r2 is True
    assert len(_capture_posts) == 2


def test_post_fail_different_sources_post_independently(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    """Dedupe key is per source_name. Different sources don't share suppression."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")
    state = tmp_path / "state.json"

    post_fail(source_name="watchdog", message="m1", state_path=state, now_ts=1_000.0)
    r2 = post_fail(source_name="gap_detect", message="m2", state_path=state, now_ts=1_001.0)

    assert r2 is True
    assert len(_capture_posts) == 2


def test_post_fail_dedupe_state_survives_process_restart(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    """State file persists; a fresh post_fail call within TTL still suppresses."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")
    state = tmp_path / "state.json"

    post_fail(source_name="x", message="m1", state_path=state, now_ts=1_000_000.0)
    assert state.exists()

    # Simulate process restart: reset module-level state and confirm dedupe via file
    alerts_mod._NO_WEBHOOK_WARNED = False
    r2 = post_fail(source_name="x", message="m2", state_path=state, now_ts=1_000_300.0)

    assert r2 is False
    assert len(_capture_posts) == 1


def test_post_fail_corrupt_state_file_treated_as_empty(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
    tmp_path: Path,
) -> None:
    """Malformed state file → start fresh, don't crash."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")
    state = tmp_path / "state.json"
    state.write_text("not-valid-json{[", encoding="utf-8")

    r = post_fail(source_name="x", message="m", state_path=state, now_ts=1_000.0)
    assert r is True
    assert len(_capture_posts) == 1


def test_post_digest_no_webhook_silent(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
) -> None:
    monkeypatch.delenv("RITHMIC_DISCORD_WEBHOOK_URL", raising=False)

    result = post_digest("MNQ 2026-05-19: sessions processed")
    assert result is False
    assert _capture_posts == []


def test_post_digest_with_webhook_fires(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
) -> None:
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")

    result = post_digest("MNQ 2026-05-19: 100K trades captured")
    assert result is True
    assert len(_capture_posts) == 1
    assert "MNQ 2026-05-19" in _capture_posts[0][1]


def test_post_digest_does_not_dedupe(
    monkeypatch: pytest.MonkeyPatch,
    _capture_posts: list[tuple[str, str]],
) -> None:
    """Daily digest is once-per-call by design; consecutive calls both fire."""
    monkeypatch.setenv("RITHMIC_DISCORD_WEBHOOK_URL", "https://discord/test")

    post_digest("call 1")
    post_digest("call 2")
    assert len(_capture_posts) == 2


def test_post_fail_docstring_documents_fail_severity_only() -> None:
    """post_fail's name is the contract — WARN goes through a different path.

    Documentation test: confirms post_fail.__doc__ documents FAIL-only semantics.
    """
    assert "FAIL" in (post_fail.__doc__ or "")
