import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { TimeoutManager, type TimeoutManagerDeps } from '../timeout-manager.js';
import type { SwapRepository } from '../../storage/repositories/swap.repository.js';
import type { SwapCaseRow } from '../../storage/repositories/swap.repository.js';

describe('TimeoutManager', () => {
  let mockRedis: Partial<Redis>;
  let mockSwapRepo: Partial<SwapRepository>;
  let mockPool: Partial<Pool>;
  let mockOnTimeout: ReturnType<typeof vi.fn>;
  let timeoutManager: TimeoutManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRedis = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zrangebyscore: vi.fn().mockResolvedValue([]),
      zscore: vi.fn().mockResolvedValue(null),
    };

    mockSwapRepo = {
      findTimedOut: vi.fn().mockResolvedValue([]),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    mockOnTimeout = vi.fn().mockResolvedValue(undefined);

    timeoutManager = new TimeoutManager({
      pool: mockPool as Pool,
      swapRepo: mockSwapRepo as SwapRepository,
      redis: mockRedis as Redis,
      onTimeout: mockOnTimeout,
    });
  });

  afterEach(() => {
    timeoutManager.stop();
    vi.restoreAllMocks();
  });

  describe('scheduleTimeout', () => {
    it('should add swap to Redis sorted set with correct score', async () => {
      const swapId = 'a'.repeat(64);
      const timeoutSeconds = 300;

      await timeoutManager.scheduleTimeout(swapId, timeoutSeconds);

      expect(mockRedis.zadd).toHaveBeenCalledTimes(1);
      const [key, score, id] = (mockRedis.zadd as any).mock.calls[0];
      expect(key).toBe('swap_timeouts');
      expect(id).toBe(swapId);
      expect(typeof score).toBe('number');
      expect(Math.abs(score - (Date.now() + timeoutSeconds * 1000))).toBeLessThan(100);
    });

    it('should schedule multiple timeouts independently', async () => {
      const swapId1 = 'a'.repeat(64);
      const swapId2 = 'b'.repeat(64);

      await timeoutManager.scheduleTimeout(swapId1, 300);
      await timeoutManager.scheduleTimeout(swapId2, 600);

      expect(mockRedis.zadd).toHaveBeenCalledTimes(2);
    });

    it('should handle timeouts with zero seconds', async () => {
      const swapId = 'a'.repeat(64);

      await timeoutManager.scheduleTimeout(swapId, 0);

      expect(mockRedis.zadd).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelTimeout', () => {
    it('should remove swap from Redis by swap ID', async () => {
      const swapId = 'a'.repeat(64);

      await timeoutManager.cancelTimeout(swapId);

      expect(mockRedis.zrem).toHaveBeenCalledTimes(1);
      expect(mockRedis.zrem).toHaveBeenCalledWith('swap_timeouts', swapId);
    });

    it('should handle cancellation of non-existent timeout', async () => {
      (mockRedis.zrem as any).mockResolvedValue(0);
      const swapId = 'a'.repeat(64);

      await timeoutManager.cancelTimeout(swapId);

      expect(mockRedis.zrem).toHaveBeenCalledWith('swap_timeouts', swapId);
    });

    it('should cancel multiple timeouts independently', async () => {
      const swapId1 = 'a'.repeat(64);
      const swapId2 = 'b'.repeat(64);

      await timeoutManager.cancelTimeout(swapId1);
      await timeoutManager.cancelTimeout(swapId2);

      expect(mockRedis.zrem).toHaveBeenCalledTimes(2);
    });
  });

  describe('start', () => {
    it('should set up two intervals for pollers', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      timeoutManager.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000);
      expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 10000);

      setIntervalSpy.mockRestore();
    });

    it('should be idempotent when called multiple times', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      timeoutManager.start();
      timeoutManager.start();
      timeoutManager.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);

      setIntervalSpy.mockRestore();
    });

    it('should set running flag to true', () => {
      timeoutManager.start();

      expect((timeoutManager as any).running).toBe(true);
    });
  });

  describe('stop', () => {
    it('should clear both intervals', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      timeoutManager.start();
      timeoutManager.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

      clearIntervalSpy.mockRestore();
    });

    it('should set running flag to false', () => {
      timeoutManager.start();
      timeoutManager.stop();

      expect((timeoutManager as any).running).toBe(false);
    });

    it('should handle being called when not started', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      timeoutManager.stop();

      expect(clearIntervalSpy).not.toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it('should be safe to call multiple times', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      timeoutManager.start();
      timeoutManager.stop();
      timeoutManager.stop();
      timeoutManager.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

      clearIntervalSpy.mockRestore();
    });
  });

  describe('recover', () => {
    it('should process already-expired swaps from DB', async () => {
      const expiredSwap: SwapCaseRow = {
        id: '1',
        swap_id: 'a'.repeat(64),
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: new Date(Date.now() - 1000),
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapRepo.findTimedOut as any).mockResolvedValue([expiredSwap]);

      await timeoutManager.recover();

      expect(mockOnTimeout).toHaveBeenCalledWith(expiredSwap.swap_id);
    });

    it('should re-schedule future timeouts to Redis', async () => {
      const futureTimeout = Date.now() + 60000;
      (mockPool.query as any).mockResolvedValue({
        rows: [
          {
            swap_id: 'b'.repeat(64),
            timeout_at: new Date(futureTimeout),
          },
        ],
      });

      await timeoutManager.recover();

      expect(mockRedis.zadd).toHaveBeenCalledWith('swap_timeouts', futureTimeout, 'b'.repeat(64));
    });

    it('should handle multiple expired and future timeouts', async () => {
      const expiredSwap1: SwapCaseRow = {
        id: '1',
        swap_id: 'a'.repeat(64),
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: new Date(Date.now() - 1000),
        completed_at: null,
        error_message: null,
        version: 1,
      };

      const expiredSwap2: SwapCaseRow = {
        ...expiredSwap1,
        swap_id: 'c'.repeat(64),
      };

      (mockSwapRepo.findTimedOut as any).mockResolvedValue([expiredSwap1, expiredSwap2]);

      const futureTimeout = Date.now() + 60000;
      (mockPool.query as any).mockResolvedValue({
        rows: [
          {
            swap_id: 'b'.repeat(64),
            timeout_at: new Date(futureTimeout),
          },
          {
            swap_id: 'd'.repeat(64),
            timeout_at: new Date(futureTimeout + 30000),
          },
        ],
      });

      await timeoutManager.recover();

      expect(mockOnTimeout).toHaveBeenCalledTimes(2);
      expect(mockRedis.zadd).toHaveBeenCalledTimes(2);
    });

    it('should not fail if no timeouts to recover', async () => {
      (mockSwapRepo.findTimedOut as any).mockResolvedValue([]);
      (mockPool.query as any).mockResolvedValue({ rows: [] });

      await expect(timeoutManager.recover()).resolves.not.toThrow();
    });
  });

  describe('pollRedis', () => {
    // Directly invoke the private pollRedis method to avoid fake timer issues
    const invokePollRedis = () => (timeoutManager as any).pollRedis();

    it('should fire onTimeout for expired entries', async () => {
      const expiredSwapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([expiredSwapId]);
      (mockRedis.zrem as any).mockResolvedValue(1);

      // Must be running for pollRedis to execute
      (timeoutManager as any).running = true;

      await invokePollRedis();
      // Wait for fire-and-forget onTimeout promise
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledWith(expiredSwapId);
    });

    it('should remove expired entries from Redis before calling onTimeout', async () => {
      const expiredSwapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([expiredSwapId]);
      (mockRedis.zrem as any).mockResolvedValue(1);

      (timeoutManager as any).running = true;

      await invokePollRedis();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRedis.zrem).toHaveBeenCalledWith('swap_timeouts', expiredSwapId);
    });

    it('should skip entries that fail to remove (already processed)', async () => {
      const expiredSwapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([expiredSwapId]);
      (mockRedis.zrem as any).mockResolvedValue(0); // Already removed

      (timeoutManager as any).running = true;

      await invokePollRedis();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).not.toHaveBeenCalled();
    });

    it('should handle errors in Redis queries gracefully', async () => {
      (mockRedis.zrangebyscore as any).mockRejectedValue(new Error('Redis connection failed'));

      (timeoutManager as any).running = true;

      // Should not throw
      await expect(invokePollRedis()).resolves.not.toThrow();

      expect(mockOnTimeout).not.toHaveBeenCalled();
    });

    it('should not run if manager is not running', async () => {
      const expiredSwapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([expiredSwapId]);

      (timeoutManager as any).running = false;

      await invokePollRedis();

      expect(mockRedis.zrangebyscore).not.toHaveBeenCalled();
    });

    it('should process multiple expired entries in a single poll', async () => {
      const swapIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];

      (mockRedis.zrangebyscore as any).mockResolvedValue(swapIds);
      (mockRedis.zrem as any).mockResolvedValue(1);

      (timeoutManager as any).running = true;

      await invokePollRedis();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledTimes(3);
      swapIds.forEach((id) => {
        expect(mockOnTimeout).toHaveBeenCalledWith(id);
      });
    });
  });

  describe('pollDatabase', () => {
    // Directly invoke the private pollDatabase method
    const invokePollDatabase = () => (timeoutManager as any).pollDatabase();

    it('should find timeouts not in Redis', async () => {
      const missedSwapId = 'a'.repeat(64);

      const missedSwap: SwapCaseRow = {
        id: '1',
        swap_id: missedSwapId,
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: new Date(Date.now() - 1000),
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapRepo.findTimedOut as any).mockResolvedValue([missedSwap]);
      (mockRedis.zscore as any).mockResolvedValue(null); // Not in Redis

      (timeoutManager as any).running = true;

      await invokePollDatabase();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledWith(missedSwapId);
    });

    it('should skip timeouts still in Redis', async () => {
      const swapId = 'a'.repeat(64);

      const swap: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: new Date(Date.now() - 1000),
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapRepo.findTimedOut as any).mockResolvedValue([swap]);
      (mockRedis.zscore as any).mockResolvedValue(Date.now() - 1000); // Still in Redis

      (timeoutManager as any).running = true;

      await invokePollDatabase();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).not.toHaveBeenCalled();
    });

    it('should handle errors in database queries gracefully', async () => {
      (mockSwapRepo.findTimedOut as any).mockRejectedValue(new Error('Database error'));

      (timeoutManager as any).running = true;

      await expect(invokePollDatabase()).resolves.not.toThrow();

      expect(mockOnTimeout).not.toHaveBeenCalled();
    });

    it('should not run if manager is not running', async () => {
      (mockSwapRepo.findTimedOut as any).mockResolvedValue([]);

      (timeoutManager as any).running = false;

      await invokePollDatabase();

      expect(mockSwapRepo.findTimedOut).not.toHaveBeenCalled();
    });

    it('should use setInterval for backup polling at 10 second intervals', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      timeoutManager.start();

      // Second call to setInterval should be the DB poller at 10s
      expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 10000);

      setIntervalSpy.mockRestore();
    });
  });

  describe('Error handling in onTimeout', () => {
    it('should catch and log errors from onTimeout handler in Redis poller', async () => {
      const swapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([swapId]);
      (mockRedis.zrem as any).mockResolvedValue(1);
      (mockOnTimeout as any).mockRejectedValue(new Error('Handler failed'));

      (timeoutManager as any).running = true;

      // Should not throw — errors are caught by the .catch() handler
      await (timeoutManager as any).pollRedis();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledWith(swapId);
    });

    it('should catch and log errors from onTimeout handler in DB poller', async () => {
      const swapId = 'a'.repeat(64);

      const swap: SwapCaseRow = {
        id: '1',
        swap_id: swapId,
        manifest: {} as any,
        state: 'PARTIAL_DEPOSIT' as any,
        party_a_deposited: '0',
        party_b_deposited: '0',
        party_a_coin_id: null,
        party_b_coin_id: null,
        created_at: new Date(),
        first_deposit_at: new Date(),
        timeout_at: new Date(Date.now() - 1000),
        completed_at: null,
        error_message: null,
        version: 1,
      };

      (mockSwapRepo.findTimedOut as any).mockResolvedValue([swap]);
      (mockRedis.zscore as any).mockResolvedValue(null);
      (mockOnTimeout as any).mockRejectedValue(new Error('Handler failed'));

      (timeoutManager as any).running = true;

      // Should not throw
      await (timeoutManager as any).pollDatabase();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledWith(swapId);
    });
  });

  describe('Integration scenarios', () => {
    it('should schedule, then timeout on Redis poll', async () => {
      const swapId = 'a'.repeat(64);

      (mockRedis.zrangebyscore as any).mockResolvedValue([swapId]);
      (mockRedis.zrem as any).mockResolvedValue(1);

      await timeoutManager.scheduleTimeout(swapId, 300);

      (timeoutManager as any).running = true;
      await (timeoutManager as any).pollRedis();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOnTimeout).toHaveBeenCalledWith(swapId);
    });

    it('should schedule, then cancel before timeout', async () => {
      const swapId = 'a'.repeat(64);

      await timeoutManager.scheduleTimeout(swapId, 300);
      await timeoutManager.cancelTimeout(swapId);

      (mockRedis.zrangebyscore as any).mockResolvedValue([]);

      (timeoutManager as any).running = true;
      await (timeoutManager as any).pollRedis();

      expect(mockOnTimeout).not.toHaveBeenCalled();
    });
  });
});
