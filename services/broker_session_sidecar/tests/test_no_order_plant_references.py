"""Source-level carve-out proving the scaffold has no order-plant implementation."""

from __future__ import annotations

from pathlib import Path

FORBIDDEN_REFERENCES = [
    "ORDER_PLANT",
    "PNL_PLANT",
    "HISTORY_PLANT",
    "submit_order",
    "cancel_order",
    "replace_order",
    "order_plant",
    "pnl_plant",
    "history_plant",
]


def test_sidecar_source_has_no_order_method_references() -> None:
    sidecar_dir = Path(__file__).resolve().parents[1]
    for source_file in sidecar_dir.rglob("*.py"):
        if "tests" in source_file.parts or "contracts" in source_file.parts:
            continue
        content = source_file.read_text(encoding="utf8")
        for forbidden in FORBIDDEN_REFERENCES:
            assert forbidden not in content, f"Forbidden reference {forbidden!r} found in {source_file}"
