import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeoutManager } from '../timeout-manager.js';

describe('TimeoutManager', () => {
  let onTimeoutMock: ReturnType<typeof vi.fn>;
  let timeoutManager: TimeoutManager;

  beforeEach(() => {
    vi.useFakeTimers();
    onTimeoutMock = vi.fn().mockResolvedValue(undefined);
    timeoutManager = new TimeoutManager({ onTimeout: onTimeoutMock });
  });

  afterEach(() => {
    timeoutManager.destroy();
    vi.useRealTimers();
  });

  describe('schedule()', () => {
    it('should schedule timeout for given milliseconds', () => {
      const swapId = 'a'.repeat(64);
      const timeoutMs = 5000;

      timeoutManager.schedule(swapId, timeoutMs);

      expect(timeoutManager.hasTimer(swapId)).toBe(true);
    });

    it('should fire callback after timeout duration elapses', async () => {
      const swapId = 'a'.repeat(64);
      const timeoutMs = 5000;

      timeoutManager.schedule(swapId, timeoutMs);

      vi.advanceTimersByTime(timeoutMs);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).toHaveBeenCalledWith(swapId);
      expect(onTimeoutMock).toHaveBeenCalledTimes(1);
    });

    it('should cancel scheduled timeout when cancel() is called', async () => {
      const swapId = 'a'.repeat(64);
      const timeoutMs = 5000;

      timeoutManager.schedule(swapId, timeoutMs);
      expect(timeoutManager.hasTimer(swapId)).toBe(true);

      timeoutManager.cancel(swapId);
      expect(timeoutManager.hasTimer(swapId)).toBe(false);

      vi.advanceTimersByTime(timeoutMs);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).not.toHaveBeenCalled();
    });

    it('should be idempotent: calling cancel() on non-existent timer is a no-op', () => {
      const swapId = 'a'.repeat(64);

      expect(() => {
        timeoutManager.cancel(swapId);
      }).not.toThrow();

      expect(timeoutManager.hasTimer(swapId)).toBe(false);
    });

    it('should not fire callback if cancelled before expiry', async () => {
      const swapId = 'a'.repeat(64);
      const timeoutMs = 5000;

      timeoutManager.schedule(swapId, timeoutMs);

      vi.advanceTimersByTime(2000);
      timeoutManager.cancel(swapId);

      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).not.toHaveBeenCalled();
    });

    it('should handle multiple concurrent timeouts for different swap IDs', async () => {
      const swapId1 = 'a'.repeat(64);
      const swapId2 = 'b'.repeat(64);
      const swapId3 = 'c'.repeat(64);

      timeoutManager.schedule(swapId1, 2000);
      timeoutManager.schedule(swapId2, 4000);
      timeoutManager.schedule(swapId3, 6000);

      vi.advanceTimersByTime(2001);
      await vi.waitFor(() => onTimeoutMock.mock.calls.length === 1);
      expect(onTimeoutMock).toHaveBeenNthCalledWith(1, swapId1);

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => onTimeoutMock.mock.calls.length === 2);
      expect(onTimeoutMock).toHaveBeenNthCalledWith(2, swapId2);

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => onTimeoutMock.mock.calls.length === 3);
      expect(onTimeoutMock).toHaveBeenNthCalledWith(3, swapId3);
    });
  });

  describe('getRemainingTime()', () => {
    it('should report remaining time for a scheduled timeout', () => {
      const swapId = 'a'.repeat(64);
      const timeoutMs = 5000;

      timeoutManager.schedule(swapId, timeoutMs);

      const remaining1 = timeoutManager.getRemainingTime(swapId);
      expect(remaining1).toBeDefined();
      expect(remaining1).toBeLessThanOrEqual(timeoutMs);
      expect(remaining1).toBeGreaterThan(0);

      vi.advanceTimersByTime(2000);

      const remaining2 = timeoutManager.getRemainingTime(swapId);
      expect(remaining2).toBeDefined();
      expect(remaining2).toBeLessThanOrEqual(3000);
      expect(remaining2).toBeGreaterThan(0);
    });

    it('should return null from getRemainingTime for non-existent timer', () => {
      const swapId = 'a'.repeat(64);

      const remaining = timeoutManager.getRemainingTime(swapId);

      expect(remaining).toBeNull();
    });
  });

  describe('reRegister()', () => {
    it('should re-register timeout with remaining time', async () => {
      const swapId = 'a'.repeat(64);

      timeoutManager.schedule(swapId, 10000);

      vi.advanceTimersByTime(3000);

      const remaining = timeoutManager.getRemainingTime(swapId)!;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(7000);

      timeoutManager.reRegister(swapId, remaining);

      expect(timeoutManager.hasTimer(swapId)).toBe(true);

      vi.advanceTimersByTime(remaining);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).toHaveBeenCalledWith(swapId);
    });

    it('should fire immediately when reRegister called with remainingMs <= 0', async () => {
      const swapId = 'a'.repeat(64);

      timeoutManager.reRegister(swapId, -1000);

      vi.advanceTimersByTime(0);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).toHaveBeenCalledWith(swapId);
    });

    it('should throw if scheduling timeout for swap that already has active timer', () => {
      const swapId = 'a'.repeat(64);

      timeoutManager.schedule(swapId, 5000);

      expect(() => {
        timeoutManager.schedule(swapId, 3000);
      }).toThrow(/Timer already exists for swap/);
    });

    it('should clear timer reference after firing (hasTimer returns false in callback)', async () => {
      const swapId = 'a'.repeat(64);
      let hasTimerDuringCallback: boolean | undefined;

      onTimeoutMock.mockImplementation(async (id: string) => {
        hasTimerDuringCallback = timeoutManager.hasTimer(id);
      });

      timeoutManager.schedule(swapId, 5000);

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(hasTimerDuringCallback).toBe(false);
      expect(timeoutManager.hasTimer(swapId)).toBe(false);
    });

    it('should not extend timeout window when re-registering after crash', async () => {
      const swapId = 'a'.repeat(64);

      // Initial schedule: 10s from now
      timeoutManager.schedule(swapId, 10000);

      // Simulate crash after 3s elapsed
      vi.advanceTimersByTime(3000);

      // Crash recovery: re-register with remaining time from persisted timeout_at
      const remaining = timeoutManager.getRemainingTime(swapId)!;
      timeoutManager.reRegister(swapId, remaining);

      // Should fire after the remaining time, not after a new 10s window
      vi.advanceTimersByTime(remaining);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).toHaveBeenCalledWith(swapId);
    });
  });

  describe('destroy()', () => {
    it('should destroy all timers on destroy()', async () => {
      const swapId1 = 'a'.repeat(64);
      const swapId2 = 'b'.repeat(64);

      timeoutManager.schedule(swapId1, 5000);
      timeoutManager.schedule(swapId2, 10000);

      expect(timeoutManager.hasTimer(swapId1)).toBe(true);
      expect(timeoutManager.hasTimer(swapId2)).toBe(true);

      timeoutManager.destroy();

      expect(timeoutManager.hasTimer(swapId1)).toBe(false);
      expect(timeoutManager.hasTimer(swapId2)).toBe(false);

      vi.advanceTimersByTime(15000);
      await vi.runAllTimersAsync();

      expect(onTimeoutMock).not.toHaveBeenCalled();
    });
  });
});
