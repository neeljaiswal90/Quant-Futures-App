"""DATA-01A sidecar constants.

This module intentionally scopes ingestion to L1 quote and last-trade records only.
MBP10/MBO remain blocked until DATA-01B parity is complete.
"""

DATA01A_PARTIAL_PARITY_STATUS = "L1_TRADE_ONLY_PASS"
DATA01A_FULL_GATE_STATUS = "blocked"
DATA01B_STATUS = "blocked_l2_l3_parity"

ALLOWED_SOURCE_STREAMS = frozenset({"L1_QUOTE", "LAST_TRADE"})
BLOCKED_SOURCE_STREAMS = frozenset({"MBP10", "MBO"})
