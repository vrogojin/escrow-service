import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { SwapRepository } from '../storage/repositories/swap.repository.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_KEY = 'swap_timeouts';

export interface TimeoutManagerDeps {
  pool: Pool;
  swapRepo: SwapRepository;
  redis: Redis;
  onTimeout: (swapId: string) => Promise<void>;
}

export class TimeoutManager {
  private pool: Pool;
  private swapRepo: SwapRepository;
  private redis: Redis;
  private onTimeout: (swapId: string) => Promise<void>;
  private redisPollerHandle: ReturnType<typeof setInterval> | null = null;
  private dbPollerHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: TimeoutManagerDeps) {
    this.pool = deps.pool;
    this.swapRepo = deps.swapRepo;
    this.redis = deps.redis;
    this.onTimeout = deps.onTimeout;
  }

  /**
   * Schedule a timeout for a swap. Writes to both Redis (fast) and PostgreSQL (durable).
   */
  async scheduleTimeout(swapId: string, timeoutSeconds: number): Promise<void> {
    const timeoutAt = Date.now() + timeoutSeconds * 1000;
    await this.redis.zadd(TIMEOUT_KEY, timeoutAt, swapId);
    logger.info({ swap_id: swapId, timeout_at: new Date(timeoutAt).toISOString() }, 'Timeout scheduled');
  }

  /**
   * Cancel a timeout (e.g., when conclusion happens before timeout).
   */
  async cancelTimeout(swapId: string): Promise<void> {
    await this.redis.zrem(TIMEOUT_KEY, swapId);
    logger.info({ swap_id: swapId }, 'Timeout cancelled');
  }

  /**
   * Start the timeout polling workers.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Redis poller: check every 1 second for expired timeouts
    this.redisPollerHandle = setInterval(() => this.pollRedis(), 1000);

    // Database backup poller: check every 10 seconds
    this.dbPollerHandle = setInterval(() => this.pollDatabase(), 10000);

    logger.info('Timeout manager started');
  }

  /**
   * Stop the timeout polling workers.
   */
  stop(): void {
    this.running = false;
    if (this.redisPollerHandle) {
      clearInterval(this.redisPollerHandle);
      this.redisPollerHandle = null;
    }
    if (this.dbPollerHandle) {
      clearInterval(this.dbPollerHandle);
      this.dbPollerHandle = null;
    }
    logger.info('Timeout manager stopped');
  }

  /**
   * Recover timeouts from the database on startup.
   */
  async recover(): Promise<void> {
    logger.info('Recovering timeouts from database');
    const timedOutSwaps = await this.swapRepo.findTimedOut();

    // Process already-expired swaps
    for (const swap of timedOutSwaps) {
      logger.info({ swap_id: swap.swap_id }, 'Processing expired timeout on recovery');
      await this.onTimeout(swap.swap_id);
    }

    // Re-schedule future timeouts from DB
    const result = await this.pool.query<{ swap_id: string; timeout_at: Date }>(
      `SELECT swap_id, timeout_at FROM swap_cases
       WHERE state = 'PARTIAL_DEPOSIT' AND timeout_at IS NOT NULL AND timeout_at > NOW()`,
    );

    for (const row of result.rows) {
      const timeoutAt = row.timeout_at.getTime();
      await this.redis.zadd(TIMEOUT_KEY, timeoutAt, row.swap_id);
      logger.info({ swap_id: row.swap_id, timeout_at: row.timeout_at }, 'Timeout re-scheduled from DB');
    }

    logger.info({ recovered: timedOutSwaps.length, rescheduled: result.rows.length }, 'Timeout recovery complete');
  }

  private async pollRedis(): Promise<void> {
    if (!this.running) return;

    try {
      const now = Date.now();
      // Get all swap IDs with timeout_at <= now
      const expired = await this.redis.zrangebyscore(TIMEOUT_KEY, 0, now);

      for (const swapId of expired) {
        // Remove from Redis first to prevent duplicate processing
        const removed = await this.redis.zrem(TIMEOUT_KEY, swapId);
        if (removed > 0) {
          logger.info({ swap_id: swapId }, 'Timeout expired (Redis poller)');
          this.onTimeout(swapId).catch((err) => {
            logger.error({ err, swap_id: swapId }, 'Error handling timeout');
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Redis timeout poll error');
    }
  }

  private async pollDatabase(): Promise<void> {
    if (!this.running) return;

    try {
      const timedOutSwaps = await this.swapRepo.findTimedOut();

      for (const swap of timedOutSwaps) {
        // Check if it's still in Redis (already being processed)
        const score = await this.redis.zscore(TIMEOUT_KEY, swap.swap_id);
        if (score === null) {
          // Not in Redis — may have been missed
          logger.info({ swap_id: swap.swap_id }, 'Timeout caught by DB backup poller');
          this.onTimeout(swap.swap_id).catch((err) => {
            logger.error({ err, swap_id: swap.swap_id }, 'Error handling timeout (DB poller)');
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Database timeout poll error');
    }
  }
}
