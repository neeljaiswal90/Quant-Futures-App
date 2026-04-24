# STRAT-06 Candidate Ranking And Tie-Breaking

`STRAT-06` adds the deterministic ranking layer used after the four V1 strategy generators emit proposed candidates.

## Scope

The ranking layer consumes already-produced `Candidate` records. It does not run strategies, recompute features, call risk, size trades, submit orders, or select live execution paths.

## Ranking Method

The V1 method is:

`deterministic_v1_confidence_rr_risk_tiebreak_v1`

Ranking uses a fixed score:

- candidate confidence;
- PT1 reward-risk;
- PT2 reward-risk;
- maximum target reward-risk;
- a small risk-points penalty.

The score constants live in `CANDIDATE_RANKING_DEFAULTS` and are intentionally grouped for the later `STRAT-07` config migration.

## Tie-Breaking

When scores are equal, candidates are ordered by:

1. higher confidence;
2. higher PT1 reward-risk;
3. higher PT2 reward-risk;
4. higher maximum reward-risk;
5. lower `risk_points`;
6. fixed strategy priority;
7. ASCII candidate ID order.

The fixed strategy priority is:

- `trend_pullback_long`;
- `trend_pullback_short`;
- `breakout_retest_long`;
- `breakdown_retest_short`.

This is deliberately deterministic and independent of input array order.

## RANK Payload

`toRankEventPayload` converts the ranking result into the OBS-01 `RANK` payload shape:

- `ranked_candidate_ids`;
- `method`.

The helper preserves candidate IDs exactly as journaled and does not infer missing candidates.

## Rejections And Ignored Candidates

Only `status = proposed` candidates are ranked. Non-proposed candidates are returned in `ignored_candidate_ids` using deterministic candidate ID order.

## STRAT-07 Config Surface

The score weights and fixed strategy priority are now represented in `config/strategies/shared.yaml`. Pure-function callers can still omit a strategy config bundle and receive the committed baseline defaults.
