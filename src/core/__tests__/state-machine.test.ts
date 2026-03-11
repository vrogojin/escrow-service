import {
  SwapState,
  isTerminalState,
  isValidTransition,
  canAcceptDeposit,
  getValidNextStates,
} from '../../core/state-machine.js';

describe('SwapState state machine', () => {
  describe('isTerminalState', () => {
    it('should return true for COMPLETED', () => {
      expect(isTerminalState(SwapState.COMPLETED)).toBe(true);
    });

    it('should return true for CANCELLED', () => {
      expect(isTerminalState(SwapState.CANCELLED)).toBe(true);
    });

    it('should return true for FAILED', () => {
      expect(isTerminalState(SwapState.FAILED)).toBe(true);
    });

    it('should return false for PARTIAL_DEPOSIT', () => {
      expect(isTerminalState(SwapState.PARTIAL_DEPOSIT)).toBe(false);
    });

    it('should return false for ANNOUNCED', () => {
      expect(isTerminalState(SwapState.ANNOUNCED)).toBe(false);
    });
  });

  describe('isValidTransition - valid transitions', () => {
    it('should allow ANNOUNCED → DEPOSIT_INVOICE_CREATED', () => {
      expect(isValidTransition(SwapState.ANNOUNCED, SwapState.DEPOSIT_INVOICE_CREATED)).toBe(true);
    });

    it('should allow DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT', () => {
      expect(isValidTransition(SwapState.DEPOSIT_INVOICE_CREATED, SwapState.PARTIAL_DEPOSIT)).toBe(true);
    });

    it('should allow DEPOSIT_INVOICE_CREATED → DEPOSIT_COVERED', () => {
      expect(isValidTransition(SwapState.DEPOSIT_INVOICE_CREATED, SwapState.DEPOSIT_COVERED)).toBe(true);
    });

    it('should allow DEPOSIT_INVOICE_CREATED → TIMED_OUT', () => {
      expect(isValidTransition(SwapState.DEPOSIT_INVOICE_CREATED, SwapState.TIMED_OUT)).toBe(true);
    });

    it('should allow PARTIAL_DEPOSIT → DEPOSIT_COVERED', () => {
      expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.DEPOSIT_COVERED)).toBe(true);
    });

    it('should allow PARTIAL_DEPOSIT → TIMED_OUT', () => {
      expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.TIMED_OUT)).toBe(true);
    });

    it('should allow DEPOSIT_COVERED → CONCLUDING', () => {
      expect(isValidTransition(SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING)).toBe(true);
    });

    it('should allow CONCLUDING → COMPLETED', () => {
      expect(isValidTransition(SwapState.CONCLUDING, SwapState.COMPLETED)).toBe(true);
    });

    it('should allow TIMED_OUT → CANCELLING', () => {
      expect(isValidTransition(SwapState.TIMED_OUT, SwapState.CANCELLING)).toBe(true);
    });

    it('should allow CANCELLING → CANCELLED', () => {
      expect(isValidTransition(SwapState.CANCELLING, SwapState.CANCELLED)).toBe(true);
    });

    it('should allow any non-terminal state → FAILED', () => {
      expect(isValidTransition(SwapState.ANNOUNCED, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.DEPOSIT_INVOICE_CREATED, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.DEPOSIT_COVERED, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.CONCLUDING, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.TIMED_OUT, SwapState.FAILED)).toBe(true);
      expect(isValidTransition(SwapState.CANCELLING, SwapState.FAILED)).toBe(true);
    });
  });

  describe('isValidTransition - invalid transitions', () => {
    it('should not allow ANNOUNCED → PARTIAL_DEPOSIT', () => {
      expect(isValidTransition(SwapState.ANNOUNCED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
    });

    it('should not allow ANNOUNCED → COMPLETED', () => {
      expect(isValidTransition(SwapState.ANNOUNCED, SwapState.COMPLETED)).toBe(false);
    });

    it('should not allow PARTIAL_DEPOSIT → CONCLUDING', () => {
      expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.CONCLUDING)).toBe(false);
    });

    it('should not allow DEPOSIT_COVERED → COMPLETED', () => {
      expect(isValidTransition(SwapState.DEPOSIT_COVERED, SwapState.COMPLETED)).toBe(false);
    });

    it('should not allow DEPOSIT_COVERED → CANCELLED', () => {
      expect(isValidTransition(SwapState.DEPOSIT_COVERED, SwapState.CANCELLED)).toBe(false);
    });

    it('should not allow CONCLUDING → CANCELLED', () => {
      expect(isValidTransition(SwapState.CONCLUDING, SwapState.CANCELLED)).toBe(false);
    });

    it('should not allow COMPLETED → any state', () => {
      expect(isValidTransition(SwapState.COMPLETED, SwapState.ANNOUNCED)).toBe(false);
      expect(isValidTransition(SwapState.COMPLETED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
      expect(isValidTransition(SwapState.COMPLETED, SwapState.CONCLUDING)).toBe(false);
    });

    it('should not allow CANCELLED → any state', () => {
      expect(isValidTransition(SwapState.CANCELLED, SwapState.ANNOUNCED)).toBe(false);
      expect(isValidTransition(SwapState.CANCELLED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
      expect(isValidTransition(SwapState.CANCELLED, SwapState.CONCLUDING)).toBe(false);
    });

    it('should not allow FAILED → any state', () => {
      expect(isValidTransition(SwapState.FAILED, SwapState.ANNOUNCED)).toBe(false);
      expect(isValidTransition(SwapState.FAILED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
      expect(isValidTransition(SwapState.FAILED, SwapState.CONCLUDING)).toBe(false);
    });

    it('should allow TIMED_OUT → DEPOSIT_COVERED (coverage wins over timeout)', () => {
      expect(isValidTransition(SwapState.TIMED_OUT, SwapState.DEPOSIT_COVERED)).toBe(true);
    });

    it('should not allow CANCELLING → DEPOSIT_COVERED', () => {
      expect(isValidTransition(SwapState.CANCELLING, SwapState.DEPOSIT_COVERED)).toBe(false);
    });

    it('should not allow CANCELLING → CONCLUDING', () => {
      expect(isValidTransition(SwapState.CANCELLING, SwapState.CONCLUDING)).toBe(false);
    });
  });

  describe('canAcceptDeposit', () => {
    it('should return true for DEPOSIT_INVOICE_CREATED', () => {
      expect(canAcceptDeposit(SwapState.DEPOSIT_INVOICE_CREATED)).toBe(true);
    });

    it('should return true for PARTIAL_DEPOSIT', () => {
      expect(canAcceptDeposit(SwapState.PARTIAL_DEPOSIT)).toBe(true);
    });

    it('should return false for ANNOUNCED', () => {
      expect(canAcceptDeposit(SwapState.ANNOUNCED)).toBe(false);
    });

    it('should return false for DEPOSIT_COVERED', () => {
      expect(canAcceptDeposit(SwapState.DEPOSIT_COVERED)).toBe(false);
    });

    it('should return false for CONCLUDING', () => {
      expect(canAcceptDeposit(SwapState.CONCLUDING)).toBe(false);
    });
  });

  describe('getValidNextStates', () => {
    it('should return [DEPOSIT_INVOICE_CREATED, FAILED] for ANNOUNCED', () => {
      const nextStates = getValidNextStates(SwapState.ANNOUNCED);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return [PARTIAL_DEPOSIT, DEPOSIT_COVERED, TIMED_OUT, FAILED] for DEPOSIT_INVOICE_CREATED', () => {
      const nextStates = getValidNextStates(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(nextStates).toHaveLength(4);
      expect(nextStates).toContain(SwapState.PARTIAL_DEPOSIT);
      expect(nextStates).toContain(SwapState.DEPOSIT_COVERED);
      expect(nextStates).toContain(SwapState.TIMED_OUT);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return [DEPOSIT_COVERED, TIMED_OUT, FAILED] for PARTIAL_DEPOSIT', () => {
      const nextStates = getValidNextStates(SwapState.PARTIAL_DEPOSIT);
      expect(nextStates).toHaveLength(3);
      expect(nextStates).toContain(SwapState.DEPOSIT_COVERED);
      expect(nextStates).toContain(SwapState.TIMED_OUT);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return [CONCLUDING, FAILED] for DEPOSIT_COVERED', () => {
      const nextStates = getValidNextStates(SwapState.DEPOSIT_COVERED);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.CONCLUDING);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return empty array for terminal states', () => {
      expect(getValidNextStates(SwapState.COMPLETED)).toEqual([]);
      expect(getValidNextStates(SwapState.CANCELLED)).toEqual([]);
      expect(getValidNextStates(SwapState.FAILED)).toEqual([]);
    });
  });
});
