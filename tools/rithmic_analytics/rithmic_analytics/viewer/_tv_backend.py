"""TV backend Protocol — documentation contract for the executor agent.

Python doesn't invoke the backend operations directly (per RA-034
Q-new-1: Option A, plan-emit only). The executor agent — a Claude Code
session loaded with TV-MCP or Chrome-MCP tools — implements this
contract by translating each plan operation into the right MCP call.

This module defines the Protocol so:

- :class:`MockBackend` (here) can be used by tests for the classification
  engine without touching real MCP transports.
- Future Option C (out-of-band MCP-client wrapper) has a stable Python
  interface to implement against — no schema change needed when that
  ships.

**Real-backend implementations are NOT in Python** — they live in the
executor agent's prompt-template logic. See ``docs/operations.md`` ↳
"Morning workflow → tv_sync executor" for the canonical prompt.

The TV-Desktop side maps to:
    ``mcp__tradingview__draw_list`` / ``draw_get_properties`` /
    ``draw_remove_one`` / ``draw_shape``.

The Tradesea side maps to ``mcp__Claude_in_Chrome__javascript_tool``
injecting into ``iframe[id^="tradingview_"]``'s
``tradingViewApi.activeChart()``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class ShapeRecord:
    """A backend-emitted shape descriptor.

    Returned by ``list_shapes`` / ``get_shape_properties``. The executor
    agent constructs these from MCP tool responses; tests construct
    them by hand against :class:`MockBackend`.
    """

    shape_id: str
    kind: str               # "reference_line" | "rectangle" | other
    label: str
    price: float | None = None
    top: float | None = None
    bot: float | None = None


class TVBackend(Protocol):
    """Documentation contract — see module docstring."""

    name: str

    def list_shapes(self, chart_id: str) -> list[ShapeRecord]:
        """Enumerate all user-drawn shapes on the chart.

        NOT called by the planner today (per safety contract: planner
        trusts state file alone). Reserved for future executor-side
        verification.
        """
        ...

    def add_shape(self, spec: dict[str, Any]) -> str:
        """Create a shape; return its new backend-specific ID."""
        ...

    def remove_shape(self, shape_id: str) -> None:
        """Remove a shape. Idempotent — ``shape_id`` already gone is OK."""
        ...

    def get_shape_properties(self, shape_id: str) -> ShapeRecord:
        """Fetch a shape's current properties."""
        ...


class MockBackend:
    """In-memory ``TVBackend`` for tests.

    The classification engine is backend-agnostic, so a single Mock
    suffices to test plan generation, state-file behaviour, idempotency,
    etc. without touching MCP transports.
    """

    name: str = "mock"

    def __init__(self) -> None:
        self._shapes: dict[str, ShapeRecord] = {}
        self._next_id: int = 1

    def list_shapes(self, chart_id: str) -> list[ShapeRecord]:  # noqa: ARG002
        return list(self._shapes.values())

    def add_shape(self, spec: dict[str, Any]) -> str:
        shape_id = f"mock-{self._next_id}"
        self._next_id += 1
        self._shapes[shape_id] = ShapeRecord(
            shape_id=shape_id,
            kind=str(spec.get("kind", "reference_line")),
            label=str(spec.get("label", "")),
            price=spec.get("price"),
            top=spec.get("top"),
            bot=spec.get("bot"),
        )
        return shape_id

    def remove_shape(self, shape_id: str) -> None:
        # Idempotent — silently no-op on missing
        self._shapes.pop(shape_id, None)

    def get_shape_properties(self, shape_id: str) -> ShapeRecord:
        return self._shapes[shape_id]

    # Test helpers (not part of Protocol)
    def seed(self, shapes: list[ShapeRecord]) -> None:
        """Inject pre-existing shapes (e.g., manual fib retracements)."""
        for s in shapes:
            self._shapes[s.shape_id] = s

    def all_shape_ids(self) -> set[str]:
        return set(self._shapes.keys())
