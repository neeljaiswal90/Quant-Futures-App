import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  selectInLoopSurvivors,
  writeInLoopSelectionArtifacts,
} from '../../../../../scripts/strategy-gen/in-loop-survivor-selection.js';

function metrics(scoreSeed: number) {
  return {
    annualized_sharpe: scoreSeed,
    profit_factor: 1.2,
    expectancy_cents: 10,
    max_drawdown_pct: 0.02,
    trade_count: 40,
    fold_scores: [1, 2, 3],
  };
}

describe('strategy-gen in-loop survivor selection', () => {
  it('selects top validation-scored survivors deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qfa-survivors-'));
    const scorePath = join(dir, 'scores.json');
    writeFileSync(scorePath, JSON.stringify({
      schema_version: 1,
      scores: [
        { candidate_strategy_id: 'candidate_a', partition_role: 'validation', metrics: metrics(1) },
        { candidate_strategy_id: 'candidate_b', partition_role: 'validation', metrics: metrics(2) },
        { candidate_strategy_id: 'candidate_c', partition_role: 'train', metrics: metrics(9) },
      ],
    }), 'utf8');

    const result = selectInLoopSurvivors({
      generationRunId: 'unit-run',
      candidateIds: ['candidate_a', 'candidate_b', 'candidate_c'],
      scoreInputPath: scorePath,
      survivorCount: 1,
    });

    expect(result.survivorCandidateIds).toEqual(['candidate_b']);
    expect(result.survivorManifest.rejected_unscored_candidate_ids).toEqual(['candidate_c']);
    expect(result.scoreLedger.score_count).toBe(3);

    writeInLoopSelectionArtifacts({
      scoreLedgerPath: join(dir, 'score-ledger.json'),
      survivorManifestPath: join(dir, 'survivors.json'),
      result,
    });
  });

  it('fails closed for unknown candidates and missing validation scores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qfa-survivors-'));
    const unknownPath = join(dir, 'unknown.json');
    writeFileSync(unknownPath, JSON.stringify({
      schema_version: 1,
      scores: [
        { candidate_strategy_id: 'unknown', partition_role: 'validation', metrics: metrics(1) },
      ],
    }), 'utf8');
    expect(() => selectInLoopSurvivors({
      generationRunId: 'unit-run',
      candidateIds: ['candidate_a'],
      scoreInputPath: unknownPath,
    })).toThrow('unknown candidate');

    const noValidationPath = join(dir, 'no-validation.json');
    writeFileSync(noValidationPath, JSON.stringify({
      schema_version: 1,
      scores: [
        { candidate_strategy_id: 'candidate_a', partition_role: 'train', metrics: metrics(1) },
      ],
    }), 'utf8');
    expect(() => selectInLoopSurvivors({
      generationRunId: 'unit-run',
      candidateIds: ['candidate_a'],
      scoreInputPath: noValidationPath,
    })).toThrow('validation score');
  });
});
