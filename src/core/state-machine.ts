export enum SwapState {
  ANNOUNCED = 'ANNOUNCED',
  DEPOSIT_INVOICE_CREATED = 'DEPOSIT_INVOICE_CREATED',
  PARTIAL_DEPOSIT = 'PARTIAL_DEPOSIT',
  DEPOSIT_COVERED = 'DEPOSIT_COVERED',
  CONCLUDING = 'CONCLUDING',
  COMPLETED = 'COMPLETED',
  TIMED_OUT = 'TIMED_OUT',
  CANCELLING = 'CANCELLING',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

const TERMINAL_STATES = new Set([
  SwapState.COMPLETED,
  SwapState.CANCELLED,
  SwapState.FAILED,
]);

const VALID_TRANSITIONS: Record<string, Set<SwapState>> = {
  [SwapState.ANNOUNCED]: new Set([
    SwapState.DEPOSIT_INVOICE_CREATED,
    SwapState.FAILED,
  ]),
  [SwapState.DEPOSIT_INVOICE_CREATED]: new Set([
    SwapState.PARTIAL_DEPOSIT,
    SwapState.DEPOSIT_COVERED,
    SwapState.TIMED_OUT,
    SwapState.FAILED,
  ]),
  [SwapState.PARTIAL_DEPOSIT]: new Set([
    SwapState.DEPOSIT_COVERED,
    SwapState.TIMED_OUT,
    SwapState.FAILED,
  ]),
  [SwapState.DEPOSIT_COVERED]: new Set([
    SwapState.DEPOSIT_COVERED, // self-transition for metadata-only updates (e.g., payout invoice ID checkpoint)
    SwapState.CONCLUDING,
    SwapState.FAILED,
  ]),
  [SwapState.CONCLUDING]: new Set([
    SwapState.CONCLUDING, // self-transition for metadata-only updates (e.g., payout B invoice ID checkpoint)
    SwapState.COMPLETED,
    SwapState.FAILED,
  ]),
  [SwapState.TIMED_OUT]: new Set([
    SwapState.DEPOSIT_COVERED,
    SwapState.CANCELLING,
    SwapState.FAILED,
  ]),
  [SwapState.CANCELLING]: new Set([
    SwapState.CANCELLED,
    SwapState.FAILED,
  ]),
};

export function isTerminalState(state: SwapState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isValidTransition(from: SwapState, to: SwapState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

export function canAcceptDeposit(state: SwapState): boolean {
  return state === SwapState.DEPOSIT_INVOICE_CREATED || state === SwapState.PARTIAL_DEPOSIT;
}

export function assertTransition(from: SwapState, to: SwapState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

export function getValidNextStates(state: SwapState): SwapState[] {
  const allowed = VALID_TRANSITIONS[state];
  return allowed ? Array.from(allowed) : [];
}
