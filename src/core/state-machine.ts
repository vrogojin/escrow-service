export enum SwapState {
  ANNOUNCED = 'ANNOUNCED',
  PARTIAL_DEPOSIT = 'PARTIAL_DEPOSIT',
  READY_TO_CONCLUDE = 'READY_TO_CONCLUDE',
  CONCLUDING = 'CONCLUDING',
  COMPLETED = 'COMPLETED',
  TIMED_OUT = 'TIMED_OUT',
  REFUNDING = 'REFUNDING',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

const TERMINAL_STATES = new Set([
  SwapState.COMPLETED,
  SwapState.REFUNDED,
  SwapState.FAILED,
]);

const VALID_TRANSITIONS: Record<string, Set<SwapState>> = {
  [SwapState.ANNOUNCED]: new Set([
    SwapState.PARTIAL_DEPOSIT,
    SwapState.READY_TO_CONCLUDE,
    SwapState.FAILED,
  ]),
  [SwapState.PARTIAL_DEPOSIT]: new Set([
    SwapState.READY_TO_CONCLUDE,
    SwapState.TIMED_OUT,
    SwapState.FAILED,
  ]),
  [SwapState.READY_TO_CONCLUDE]: new Set([
    SwapState.CONCLUDING,
    SwapState.FAILED,
  ]),
  [SwapState.CONCLUDING]: new Set([
    SwapState.COMPLETED,
    SwapState.FAILED,
  ]),
  [SwapState.TIMED_OUT]: new Set([
    SwapState.REFUNDING,
    SwapState.FAILED,
  ]),
  [SwapState.REFUNDING]: new Set([
    SwapState.REFUNDED,
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
  return state === SwapState.ANNOUNCED || state === SwapState.PARTIAL_DEPOSIT;
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
