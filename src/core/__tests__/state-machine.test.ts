import {
  SwapState,
  isTerminalState,
  isValidTransition,
  canAcceptDeposit,
  assertTransition,
  getValidNextStates,
} from '../../core/state-machine.js';

describe('SwapState state machine', () => {
  describe('isTerminalState', () => {
    it('should return true for COMPLETED', () => {
      expect(isTerminalState(SwapState.COMPLETED)).toBe(true);
    });

    it('should return true for REFUNDED', () => {
      expect(isTerminalState(SwapState.REFUNDED)).toBe(true);
    });

    it('should return true for FAILED', () => {
      expect(isTerminalState(SwapState.FAILED)).toBe(true);
    });

    it('should return false for ANNOUNCED', () => {
      expect(isTerminalState(SwapState.ANNOUNCED)).toBe(false);
    });

    it('should return false for PARTIAL_DEPOSIT', () => {
      expect(isTerminalState(SwapState.PARTIAL_DEPOSIT)).toBe(false);
    });

    it('should return false for READY_TO_CONCLUDE', () => {
      expect(isTerminalState(SwapState.READY_TO_CONCLUDE)).toBe(false);
    });

    it('should return false for CONCLUDING', () => {
      expect(isTerminalState(SwapState.CONCLUDING)).toBe(false);
    });

    it('should return false for TIMED_OUT', () => {
      expect(isTerminalState(SwapState.TIMED_OUT)).toBe(false);
    });

    it('should return false for REFUNDING', () => {
      expect(isTerminalState(SwapState.REFUNDING)).toBe(false);
    });
  });

  describe('isValidTransition', () => {
    describe('valid transitions', () => {
      it('should allow ANNOUNCED → PARTIAL_DEPOSIT', () => {
        expect(isValidTransition(SwapState.ANNOUNCED, SwapState.PARTIAL_DEPOSIT)).toBe(true);
      });

      it('should allow ANNOUNCED → READY_TO_CONCLUDE', () => {
        expect(isValidTransition(SwapState.ANNOUNCED, SwapState.READY_TO_CONCLUDE)).toBe(true);
      });

      it('should allow ANNOUNCED → FAILED', () => {
        expect(isValidTransition(SwapState.ANNOUNCED, SwapState.FAILED)).toBe(true);
      });

      it('should allow PARTIAL_DEPOSIT → READY_TO_CONCLUDE', () => {
        expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.READY_TO_CONCLUDE)).toBe(true);
      });

      it('should allow PARTIAL_DEPOSIT → TIMED_OUT', () => {
        expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.TIMED_OUT)).toBe(true);
      });

      it('should allow PARTIAL_DEPOSIT → FAILED', () => {
        expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.FAILED)).toBe(true);
      });

      it('should allow READY_TO_CONCLUDE → CONCLUDING', () => {
        expect(isValidTransition(SwapState.READY_TO_CONCLUDE, SwapState.CONCLUDING)).toBe(true);
      });

      it('should allow READY_TO_CONCLUDE → FAILED', () => {
        expect(isValidTransition(SwapState.READY_TO_CONCLUDE, SwapState.FAILED)).toBe(true);
      });

      it('should allow CONCLUDING → COMPLETED', () => {
        expect(isValidTransition(SwapState.CONCLUDING, SwapState.COMPLETED)).toBe(true);
      });

      it('should allow CONCLUDING → FAILED', () => {
        expect(isValidTransition(SwapState.CONCLUDING, SwapState.FAILED)).toBe(true);
      });

      it('should allow TIMED_OUT → REFUNDING', () => {
        expect(isValidTransition(SwapState.TIMED_OUT, SwapState.REFUNDING)).toBe(true);
      });

      it('should allow TIMED_OUT → FAILED', () => {
        expect(isValidTransition(SwapState.TIMED_OUT, SwapState.FAILED)).toBe(true);
      });

      it('should allow REFUNDING → REFUNDED', () => {
        expect(isValidTransition(SwapState.REFUNDING, SwapState.REFUNDED)).toBe(true);
      });

      it('should allow REFUNDING → FAILED', () => {
        expect(isValidTransition(SwapState.REFUNDING, SwapState.FAILED)).toBe(true);
      });
    });

    describe('invalid transitions', () => {
      it('should not allow ANNOUNCED → COMPLETED', () => {
        expect(isValidTransition(SwapState.ANNOUNCED, SwapState.COMPLETED)).toBe(false);
      });

      it('should not allow ANNOUNCED → TIMED_OUT', () => {
        expect(isValidTransition(SwapState.ANNOUNCED, SwapState.TIMED_OUT)).toBe(false);
      });

      it('should not allow PARTIAL_DEPOSIT → COMPLETED', () => {
        expect(isValidTransition(SwapState.PARTIAL_DEPOSIT, SwapState.COMPLETED)).toBe(false);
      });

      it('should not allow COMPLETED → REFUNDING', () => {
        expect(isValidTransition(SwapState.COMPLETED, SwapState.REFUNDING)).toBe(false);
      });

      it('should not allow COMPLETED → REFUNDED', () => {
        expect(isValidTransition(SwapState.COMPLETED, SwapState.REFUNDED)).toBe(false);
      });

      it('should not allow COMPLETED → FAILED', () => {
        expect(isValidTransition(SwapState.COMPLETED, SwapState.FAILED)).toBe(false);
      });

      it('should not allow REFUNDED → ANNOUNCED', () => {
        expect(isValidTransition(SwapState.REFUNDED, SwapState.ANNOUNCED)).toBe(false);
      });

      it('should not allow REFUNDED → PARTIAL_DEPOSIT', () => {
        expect(isValidTransition(SwapState.REFUNDED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
      });

      it('should not allow FAILED → ANNOUNCED', () => {
        expect(isValidTransition(SwapState.FAILED, SwapState.ANNOUNCED)).toBe(false);
      });

      it('should not allow FAILED → PARTIAL_DEPOSIT', () => {
        expect(isValidTransition(SwapState.FAILED, SwapState.PARTIAL_DEPOSIT)).toBe(false);
      });
    });
  });

  describe('canAcceptDeposit', () => {
    it('should return true for ANNOUNCED', () => {
      expect(canAcceptDeposit(SwapState.ANNOUNCED)).toBe(true);
    });

    it('should return true for PARTIAL_DEPOSIT', () => {
      expect(canAcceptDeposit(SwapState.PARTIAL_DEPOSIT)).toBe(true);
    });

    it('should return false for READY_TO_CONCLUDE', () => {
      expect(canAcceptDeposit(SwapState.READY_TO_CONCLUDE)).toBe(false);
    });

    it('should return false for CONCLUDING', () => {
      expect(canAcceptDeposit(SwapState.CONCLUDING)).toBe(false);
    });

    it('should return false for COMPLETED', () => {
      expect(canAcceptDeposit(SwapState.COMPLETED)).toBe(false);
    });

    it('should return false for TIMED_OUT', () => {
      expect(canAcceptDeposit(SwapState.TIMED_OUT)).toBe(false);
    });

    it('should return false for REFUNDING', () => {
      expect(canAcceptDeposit(SwapState.REFUNDING)).toBe(false);
    });

    it('should return false for REFUNDED', () => {
      expect(canAcceptDeposit(SwapState.REFUNDED)).toBe(false);
    });

    it('should return false for FAILED', () => {
      expect(canAcceptDeposit(SwapState.FAILED)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('should not throw for valid transition ANNOUNCED → PARTIAL_DEPOSIT', () => {
      expect(() => {
        assertTransition(SwapState.ANNOUNCED, SwapState.PARTIAL_DEPOSIT);
      }).not.toThrow();
    });

    it('should not throw for valid transition PARTIAL_DEPOSIT → READY_TO_CONCLUDE', () => {
      expect(() => {
        assertTransition(SwapState.PARTIAL_DEPOSIT, SwapState.READY_TO_CONCLUDE);
      }).not.toThrow();
    });

    it('should not throw for valid transition CONCLUDING → COMPLETED', () => {
      expect(() => {
        assertTransition(SwapState.CONCLUDING, SwapState.COMPLETED);
      }).not.toThrow();
    });

    it('should throw for invalid transition ANNOUNCED → COMPLETED', () => {
      expect(() => {
        assertTransition(SwapState.ANNOUNCED, SwapState.COMPLETED);
      }).toThrow(/Invalid state transition/);
    });

    it('should throw for invalid transition COMPLETED → REFUNDING', () => {
      expect(() => {
        assertTransition(SwapState.COMPLETED, SwapState.REFUNDING);
      }).toThrow(/Invalid state transition/);
    });

    it('should throw for invalid transition REFUNDED → ANNOUNCED', () => {
      expect(() => {
        assertTransition(SwapState.REFUNDED, SwapState.ANNOUNCED);
      }).toThrow(/Invalid state transition/);
    });

    it('should throw for invalid transition FAILED → PARTIAL_DEPOSIT', () => {
      expect(() => {
        assertTransition(SwapState.FAILED, SwapState.PARTIAL_DEPOSIT);
      }).toThrow(/Invalid state transition/);
    });

    it('should include both states in error message', () => {
      expect(() => {
        assertTransition(SwapState.ANNOUNCED, SwapState.COMPLETED);
      }).toThrow(/ANNOUNCED/);
    });

    it('should include target state in error message', () => {
      expect(() => {
        assertTransition(SwapState.ANNOUNCED, SwapState.COMPLETED);
      }).toThrow(/COMPLETED/);
    });
  });

  describe('getValidNextStates', () => {
    it('should return correct next states for ANNOUNCED', () => {
      const nextStates = getValidNextStates(SwapState.ANNOUNCED);
      expect(nextStates).toHaveLength(3);
      expect(nextStates).toContain(SwapState.PARTIAL_DEPOSIT);
      expect(nextStates).toContain(SwapState.READY_TO_CONCLUDE);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return correct next states for PARTIAL_DEPOSIT', () => {
      const nextStates = getValidNextStates(SwapState.PARTIAL_DEPOSIT);
      expect(nextStates).toHaveLength(3);
      expect(nextStates).toContain(SwapState.READY_TO_CONCLUDE);
      expect(nextStates).toContain(SwapState.TIMED_OUT);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return correct next states for READY_TO_CONCLUDE', () => {
      const nextStates = getValidNextStates(SwapState.READY_TO_CONCLUDE);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.CONCLUDING);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return correct next states for CONCLUDING', () => {
      const nextStates = getValidNextStates(SwapState.CONCLUDING);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.COMPLETED);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return correct next states for TIMED_OUT', () => {
      const nextStates = getValidNextStates(SwapState.TIMED_OUT);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.REFUNDING);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return correct next states for REFUNDING', () => {
      const nextStates = getValidNextStates(SwapState.REFUNDING);
      expect(nextStates).toHaveLength(2);
      expect(nextStates).toContain(SwapState.REFUNDED);
      expect(nextStates).toContain(SwapState.FAILED);
    });

    it('should return empty array for terminal state COMPLETED', () => {
      const nextStates = getValidNextStates(SwapState.COMPLETED);
      expect(nextStates).toEqual([]);
    });

    it('should return empty array for terminal state REFUNDED', () => {
      const nextStates = getValidNextStates(SwapState.REFUNDED);
      expect(nextStates).toEqual([]);
    });

    it('should return empty array for terminal state FAILED', () => {
      const nextStates = getValidNextStates(SwapState.FAILED);
      expect(nextStates).toEqual([]);
    });
  });
});
