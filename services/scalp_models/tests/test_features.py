from scalp_models.features import FEATURE_NAMES, build_feature_vector, feature_vector_values


def test_feature_vector_is_stable_and_exhaustive() -> None:
    row = {
        "setup_type": "zone_rejection",
        "confluence_stack_size": 3,
        "regime": "HIGH",
        "zone_context": {"kind": "W+2sigma", "distance_pts": -1.25},
        "features": {"sigma": 42, "atr_14": 70},
        "orderflow_snapshot": {
            "quality": "live",
            "last_trade_aggressor": "buy",
            "v_delta": 120,
            "cvd": {
                "session_cvd": 1000,
                "last_60m_cvd": 250,
                "last_15m_cvd": -20,
                "momentum_flip": True,
                "session_direction": "bullish",
                "last_15m_direction": "bearish",
            },
            "aggressor_windows": [{"window_seconds": 60, "net": 12, "ratio": 0.6}],
            "footprint": {"imbalance": 1.7},
        },
        "depth_snapshot": {
            "quality": "inferred",
            "mid": 100.25,
            "bid_levels": [{"price": 100.0, "size": 30}, {"price": 99.75, "size": 20}],
            "ask_levels": [{"price": 100.5, "size": 10}, {"price": 100.75, "size": 5}],
        },
    }

    vector = build_feature_vector(row)

    assert tuple(vector) == FEATURE_NAMES
    assert vector["cvd_session_cvd"] == 1000
    assert vector["cvd_momentum_flip"] == 1.0
    assert vector["aggressor_60s_net"] == 12
    assert vector["last_trade_aggressor_buy"] == 1.0
    assert vector["cvd_last_15m_direction_bearish"] == 1.0
    assert vector["zone_kind_sigma"] == 1.0
    assert vector["regime_HIGH"] == 1.0
    assert vector["depth_top3_bid_ratio"] > 0.5
    assert len(feature_vector_values(row)) == len(FEATURE_NAMES)
