"""Tests for ``rithmic_analytics.core.contracts``."""

from __future__ import annotations

import dataclasses

import pytest

from rithmic_analytics.core.contracts import MNQ, ContractSpec


def test_mnq_field_values() -> None:
    assert MNQ.root == "MNQ"
    assert MNQ.tick_size == 0.25
    assert MNQ.dollars_per_tick == 0.50
    assert MNQ.dollars_per_point == 2.00


def test_mnq_dollar_invariant_holds() -> None:
    # dollars_per_point * tick_size must equal dollars_per_tick.
    # Cash math derives from this; if it drifts, every $ calc downstream breaks.
    assert abs(MNQ.dollars_per_point * MNQ.tick_size - MNQ.dollars_per_tick) < 1e-9


def test_contract_spec_is_frozen() -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        MNQ.tick_size = 0.5  # type: ignore[misc]


def test_contract_spec_uses_slots() -> None:
    # slots=True populates __slots__ on the class.
    assert hasattr(ContractSpec, "__slots__")
    assert set(ContractSpec.__slots__) == {
        "root",
        "tick_size",
        "dollars_per_tick",
        "dollars_per_point",
    }
