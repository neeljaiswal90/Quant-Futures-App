from __future__ import annotations

from typing import Any


def sample_envelope() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": "rth",
        "vpoc": 29237.5,
        "vah": 29425.0,
        "val": 29162.5,
        "atr_14": 40.0,
        "bin_size_ticks": 10,
        "zones": [
            {
                "id": "hvn-29237.5",
                "top": 29240.0,
                "bot": 29237.5,
                "type": "support",
                "conviction": "MED",
                "text": "HVN 1.8%",
                "sources": ["hvn_rth"],
            },
            {
                "id": "super-zone",
                "top": 29555.0,
                "bot": 29550.0,
                "type": "resistance",
                "conviction": "SUPER",
                "text": "Upper LVN/HVN cluster",
                "sources": ["hvn_rth"],
            },
        ],
        "reference_lines": [
            {"price": 29237.5, "text": "VPOC 29237.5", "source": "vpoc"},
            {"price": 29425.0, "text": "VAH 29425", "source": "vah"},
            {"price": 29162.5, "text": "VAL 29162.5", "source": "val"},
            {"price": 29137.5, "text": "LVN 151", "source": "lvn_rth"},
            {"price": 29552.5, "text": "LVN 161", "source": "lvn_rth"},
            {"price": 29550.0, "text": "LVN 538", "source": "lvn_rth"},
            {"price": 29553.75, "text": "Cycle High 29553.75", "source": "cycle_high"},
            {"price": 29337.25, "text": "VWAP RTH 29337.25", "source": "vwap_rth"},
            {"price": 29441.8, "text": "VWAP RTH +1sd", "source": "vwap_rth_band_p1sd"},
            {"price": 29232.71, "text": "VWAP RTH -1sd", "source": "vwap_rth_band_m1sd"},
            {"price": 29546.34, "text": "VWAP RTH +2sd", "source": "vwap_rth_band_p2sd"},
        ],
    }
