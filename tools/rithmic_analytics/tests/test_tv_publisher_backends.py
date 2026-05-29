"""Backend Protocol compliance tests for ``rithmic_analytics.viewer._tv_backend``.

Real backends (TV-Desktop via MCP, Tradesea via Chrome MCP) live in the
executor agent's prompt template — they're not Python objects. These
tests cover the Protocol contract via the in-memory ``MockBackend`` used
by the publisher tests.
"""

from __future__ import annotations

import pytest

from rithmic_analytics.viewer._tv_backend import MockBackend, ShapeRecord


def test_mock_backend_starts_empty() -> None:
    b = MockBackend()
    assert b.list_shapes("MNQ") == []


def test_mock_backend_add_returns_unique_ids() -> None:
    b = MockBackend()
    id1 = b.add_shape({"kind": "reference_line", "label": "VPOC", "price": 100.0})
    id2 = b.add_shape({"kind": "reference_line", "label": "VAH", "price": 110.0})
    assert id1 != id2
    assert id1.startswith("mock-")


def test_mock_backend_get_returns_shape() -> None:
    b = MockBackend()
    sid = b.add_shape({"kind": "rectangle", "label": "HVN", "top": 110.0, "bot": 100.0})
    rec = b.get_shape_properties(sid)
    assert rec.kind == "rectangle"
    assert rec.label == "HVN"
    assert rec.top == 110.0
    assert rec.bot == 100.0


def test_mock_backend_remove_makes_shape_unfindable() -> None:
    b = MockBackend()
    sid = b.add_shape({"kind": "reference_line", "label": "X", "price": 100.0})
    assert sid in b.all_shape_ids()
    b.remove_shape(sid)
    assert sid not in b.all_shape_ids()


def test_mock_backend_remove_missing_is_idempotent() -> None:
    """Remove of unknown shape_id must not raise — matches the real-backend
    idempotency contract (executor calls remove blind sometimes)."""
    b = MockBackend()
    # Should not raise
    b.remove_shape("never-existed")


def test_mock_backend_seed_preserves_shapes_across_operations() -> None:
    """The seed() helper injects pre-existing user shapes (e.g. manual fibs).
    These must survive every other operation we make on the backend."""
    b = MockBackend()
    b.seed([
        ShapeRecord(
            shape_id="user-fib-1", kind="trend_line", label="Fib 0.618",
            top=27500.0, bot=27200.0,
        ),
    ])
    # Add a tv_sync shape and remove a different tv_sync shape — fib survives
    sid = b.add_shape({"kind": "reference_line", "label": "VPOC", "price": 27381.25})
    b.remove_shape(sid)
    assert "user-fib-1" in b.all_shape_ids()


def test_shape_record_is_frozen() -> None:
    import dataclasses
    r = ShapeRecord(shape_id="x", kind="reference_line", label="X")
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.label = "Y"  # type: ignore[misc]
