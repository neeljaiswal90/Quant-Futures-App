/**
 * Deterministic TypeScript evaluator for an XGBoost `binary:logistic` model
 * exported via `booster.save_model('model.json')`.
 *
 * The meta-labeling trainer (Python) produces the model JSON; this evaluator
 * reproduces its predictions at the in-loop take/skip gate with no Python at
 * inference time. Parity with `xgboost.predict` is guaranteed by
 * meta-label-parity.test.ts against a committed fixture.
 *
 * Inference: proba = sigmoid( logit(base_score) + sum_over_trees(leaf_weight) ).
 * Missing features follow each node's `default_left`. Categorical splits are
 * rejected (the meta-labeler uses only numeric / pre-encoded features).
 */

const SUPPORTED_OBJECTIVE = 'binary:logistic';

export interface MetaLabelTree {
  readonly split_indices: readonly number[];
  readonly split_conditions: readonly number[];
  readonly left_children: readonly number[];
  readonly right_children: readonly number[];
  readonly default_left: readonly number[];
  readonly base_weights: readonly number[];
}

export interface MetaLabelModel {
  /** logit(base_score): the intercept in margin space. */
  readonly base_margin: number;
  readonly num_feature: number;
  readonly trees: readonly MetaLabelTree[];
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`meta-label model: ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberArray(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'number')) {
    throw new Error(`meta-label model: ${path} must be a number[]`);
  }
  return value as readonly number[];
}

function parseBaseScoreProbability(raw: unknown): number {
  // XGBoost stores base_score as a bracketed string in probability space,
  // e.g. "[5.5078125E-1]". For multi-output it is a list; binary uses one value.
  if (typeof raw !== 'string') {
    throw new Error('meta-label model: base_score must be a string');
  }
  const first = raw.replace(/^\[/, '').replace(/\]$/, '').split(',')[0];
  if (first === undefined) {
    throw new Error(`meta-label model: base_score malformed: ${raw}`);
  }
  const probability = Number(first.trim());
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error(`meta-label model: base_score must be in (0,1): ${raw}`);
  }
  return probability;
}

function parseTree(raw: unknown, index: number): MetaLabelTree {
  const tree = asRecord(raw, `trees[${index}]`);
  const splitType = tree.split_type;
  if (Array.isArray(splitType) && splitType.some((entry) => entry !== 0)) {
    throw new Error(
      `meta-label model: trees[${index}] uses categorical splits (unsupported); ` +
        'encode categories numerically before training',
    );
  }
  return {
    split_indices: numberArray(tree.split_indices, `trees[${index}].split_indices`),
    split_conditions: numberArray(tree.split_conditions, `trees[${index}].split_conditions`),
    left_children: numberArray(tree.left_children, `trees[${index}].left_children`),
    right_children: numberArray(tree.right_children, `trees[${index}].right_children`),
    default_left: numberArray(tree.default_left, `trees[${index}].default_left`),
    base_weights: numberArray(tree.base_weights, `trees[${index}].base_weights`),
  };
}

export function parseMetaLabelModel(json: unknown): MetaLabelModel {
  const learner = asRecord(asRecord(json, 'root').learner, 'learner');
  const objective = asRecord(learner.objective, 'learner.objective');
  if (objective.name !== SUPPORTED_OBJECTIVE) {
    throw new Error(
      `meta-label model: unsupported objective ${String(objective.name)}; ` +
        `expected ${SUPPORTED_OBJECTIVE}`,
    );
  }
  const param = asRecord(learner.learner_model_param, 'learner.learner_model_param');
  const numFeature = Number(param.num_feature);
  if (!Number.isInteger(numFeature) || numFeature <= 0) {
    throw new Error('meta-label model: learner_model_param.num_feature invalid');
  }
  const baseScore = parseBaseScoreProbability(param.base_score);
  const model = asRecord(
    asRecord(learner.gradient_booster, 'learner.gradient_booster').model,
    'gradient_booster.model',
  );
  const rawTrees = model.trees;
  if (!Array.isArray(rawTrees) || rawTrees.length === 0) {
    throw new Error('meta-label model: gradient_booster.model.trees is empty');
  }
  return {
    base_margin: Math.log(baseScore / (1 - baseScore)),
    num_feature: numFeature,
    trees: rawTrees.map((tree, index) => parseTree(tree, index)),
  };
}

function evaluateTreeLeaf(tree: MetaLabelTree, features: ReadonlyArray<number | null>): number {
  let node = 0;
  // A leaf has no children: left_children[node] === -1.
  while (tree.left_children[node] !== -1) {
    const featureIndex = tree.split_indices[node]!;
    const value = features[featureIndex];
    // xgboost compares in float32 (DMatrix is float32); Math.fround on both
    // operands reproduces its branch selection exactly at split boundaries.
    const goLeft =
      value === null || value === undefined || Number.isNaN(value)
        ? tree.default_left[node] === 1
        : Math.fround(value) < Math.fround(tree.split_conditions[node]!);
    node = goLeft ? tree.left_children[node]! : tree.right_children[node]!;
  }
  return tree.base_weights[node]!;
}

export function predictMetaLabelProbability(
  model: MetaLabelModel,
  features: ReadonlyArray<number | null>,
): number {
  let margin = model.base_margin;
  for (const tree of model.trees) {
    margin += evaluateTreeLeaf(tree, features);
  }
  return 1 / (1 + Math.exp(-margin));
}

export function metaLabelTake(
  model: MetaLabelModel,
  features: ReadonlyArray<number | null>,
  takeThreshold: number,
): boolean {
  return predictMetaLabelProbability(model, features) >= takeThreshold;
}
