"""DATA sidecar constants.

DATA-01A scopes ingestion to L1 quote and last-trade records only. DATA-01B-PS adds the
accepted MBP10 price-state sub-scope while keeping MBO and full DATA-01B blocked.
"""

DATA01A_PARTIAL_PARITY_STATUS = "L1_TRADE_ONLY_PASS"
DATA01A_FULL_GATE_STATUS = "blocked"
DATA01B_STATUS = "blocked_l2_l3_parity"
DATA01B_MBP10_PRICE_STATE_STATUS = "accepted_subscope"
DATA01B_MBO_STATUS = "blocked"
DATA01B_SIZE_ORDER_COUNT_STATUS = "diagnostic_only"
DATA01B_FULL_STATUS = "blocked"
DATA01B_MBO_BLOCK_REASON = "mbo_parity_blocked_action_taxonomy_unresolved"

ALLOWED_SOURCE_STREAMS = frozenset({"L1_QUOTE", "LAST_TRADE"})
BLOCKED_SOURCE_STREAMS = frozenset({"MBP10", "MBO"})
