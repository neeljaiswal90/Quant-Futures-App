import type { ExitReason } from '../../contracts/position.js';

export function computeExitReasonDetailed(
  reason: ExitReason,
  partialExitDone: boolean,
  trailingActive: boolean,
): ExitReason {
  if (reason !== 'stop_loss') return reason;
  if (!partialExitDone) return 'stop_loss_initial';
  return trailingActive ? 'stop_loss_trailing' : 'stop_loss_breakeven';
}

export function isStoppedOut(reason: ExitReason): boolean {
  return reason === 'stop_loss'
    || reason === 'stop_loss_initial'
    || reason === 'stop_loss_breakeven'
    || reason === 'stop_loss_trailing';
}
