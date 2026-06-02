"""RA-112e step 10 — tail-cap calibration (offline pre-compute).

Reads recent completed sessions' obs01 capture streams, computes overlapping
realized-range distributions, and writes a per-session-kind JSON used by the
sigma-zones v3 cap formula at runtime.

Run via:
    python -m realtime_backend.calibration.compute_tail_cap --session rth
"""
