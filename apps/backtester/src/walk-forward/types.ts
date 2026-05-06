export interface SessionDateRange {
  readonly start_session: string;
  readonly end_session: string;
}

export interface WalkForwardPolicy {
  readonly policy_version: 1;
  readonly train_sessions: number;
  readonly validation_sessions: number;
  readonly test_sessions: number;
  readonly step_sessions: number;
  readonly min_required_sessions: number;
}

export interface WalkForwardWindow {
  readonly window_id: string;
  readonly sequence: number;
  readonly train: SessionDateRange;
  readonly validation: SessionDateRange;
  readonly test: SessionDateRange;
}

export interface WalkForwardPlan {
  readonly policy: WalkForwardPolicy;
  readonly sessions: readonly string[];
  readonly windows: readonly WalkForwardWindow[];
}

export type SessionKeyConvention = 'date' | 'date-rth';
