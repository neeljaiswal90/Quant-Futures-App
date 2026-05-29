"""Contract metadata for the symbols this analytics layer handles.

Per the kickoff scope decision (Q4: tight scope, MNQ only), this module exposes
a single `MNQ` `ContractSpec` instance rather than a registry / `get_contract()`
lookup. Adding another symbol later means appending one module-level constant.

Example:
    >>> from rithmic_analytics.core.contracts import MNQ
    >>> MNQ.tick_size
    0.25
    >>> MNQ.dollars_per_point
    2.0
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ContractSpec:
    """Immutable per-contract metadata.

    Attributes:
        root: Root symbol (e.g. ``"MNQ"``) — front-month is resolved separately
            by ``ops/rollover_calendar.py``.
        tick_size: Minimum price increment in index points.
        dollars_per_tick: Cash value of one tick.
        dollars_per_point: Cash value of a one-point move
            (= ``dollars_per_tick / tick_size``).

    Invariant:
        ``dollars_per_point * tick_size == dollars_per_tick`` (within fp).
    """

    root: str
    tick_size: float
    dollars_per_tick: float
    dollars_per_point: float


MNQ: ContractSpec = ContractSpec(
    root="MNQ",
    tick_size=0.25,
    dollars_per_tick=0.50,
    dollars_per_point=2.00,
)
"""E-mini Micro Nasdaq-100 futures (CME). $2 per index point."""
