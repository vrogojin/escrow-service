/**
 * TimeoutManager
 *
 * Simplified in-process timer manager for swap timeouts. Replaces the previous
 * Redis + PostgreSQL-based implementation with plain Node.js setTimeout handles.
 *
 * The timer starts from the first deposit event, not from manifest submission.
 * On crash recovery, remaining time is computed from the persisted timeout_at
 * timestamp and passed to reRegister().
 *
 * The AccountingModule's dueDate is informational only — the escrow enforces
 * timeouts at the application level via this class.
 */

import { logger } from '../utils/logger.js';

export interface TimeoutManagerDeps {
  /** Callback invoked when a swap's timeout expires. */
  onTimeout: (swapId: string) => Promise<void>;
}

/** Internal record storing the timer handle and deadline for each swap. */
interface TimerEntry {
  handle: NodeJS.Timeout;
  deadlineMs: number;
}

/**
 * Manages application-level timeout timers for active swaps.
 *
 * Each swap gets at most one active timer. Timers are stored in memory —
 * crash recovery must use reRegister() with the remaining time computed
 * from persisted timeout_at.
 */
export class TimeoutManager {
  private readonly timers = new Map<string, TimerEntry>();
  private readonly onTimeout: (swapId: string) => Promise<void>;
  private destroyed = false;

  constructor(deps: TimeoutManagerDeps) {
    this.onTimeout = deps.onTimeout;
  }

  /**
   * Schedules a timeout for a swap.
   *
   * @param swapId - The swap identifier.
   * @param timeoutMs - Milliseconds from now until timeout fires.
   * @throws Error if a timer already exists for this swap (caller must cancel first).
   */
  schedule(swapId: string, timeoutMs: number): void {
    if (this.destroyed) {
      throw new Error(`TimeoutManager: schedule() called after destroy() for swap ${swapId}`);
    }
    if (this.timers.has(swapId)) {
      throw new Error(`Timer already exists for swap ${swapId}. Cancel before rescheduling.`);
    }

    const deadlineMs = Date.now() + timeoutMs;
    this._scheduleInternal(swapId, timeoutMs, deadlineMs);

    logger.info({ swap_id: swapId, timeoutMs, deadlineAt: new Date(deadlineMs).toISOString() }, 'Timeout scheduled');
  }

  /**
   * Cancels an active timeout timer.
   *
   * Idempotent — silently does nothing if no timer exists for the swap.
   *
   * @param swapId - The swap identifier.
   */
  cancel(swapId: string): void {
    const entry = this.timers.get(swapId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.handle);
    this.timers.delete(swapId);
    logger.info({ swap_id: swapId }, 'Timeout cancelled');
  }

  /**
   * Returns the remaining time in milliseconds for a scheduled timer.
   *
   * @param swapId - The swap identifier.
   * @returns Remaining milliseconds (may be negative if overdue), or null if no timer.
   */
  getRemainingTime(swapId: string): number | null {
    const entry = this.timers.get(swapId);
    if (!entry) {
      return null;
    }
    return entry.deadlineMs - Date.now();
  }

  /**
   * Re-registers a timeout for crash recovery.
   *
   * Unlike schedule(), this method accepts the remaining time (not the full
   * original timeout). If remainingMs <= 0, the timeout fires immediately
   * (in the next microtask turn via setTimeout(fn, 0)).
   *
   * Does NOT throw if a timer already exists — it cancels the existing one first.
   * This is intentional: during recovery, the swap may already have been
   * re-subscribed and a timer may have been set.
   *
   * @param swapId - The swap identifier.
   * @param remainingMs - Milliseconds remaining until timeout (from persisted timeout_at).
   */
  reRegister(swapId: string, remainingMs: number): void {
    if (this.destroyed) {
      throw new Error(`TimeoutManager: reRegister() called after destroy() for swap ${swapId}`);
    }
    // Cancel any existing timer to avoid duplicates
    this.cancel(swapId);

    const effectiveMs = Math.max(0, remainingMs);
    const deadlineMs = Date.now() + effectiveMs;
    this._scheduleInternal(swapId, effectiveMs, deadlineMs);

    logger.info(
      { swap_id: swapId, remainingMs, effectiveMs, deadlineAt: new Date(deadlineMs).toISOString() },
      'Timeout re-registered (crash recovery)',
    );
  }

  /**
   * Returns whether a timer is currently scheduled for the given swap.
   *
   * @param swapId - The swap identifier.
   */
  hasTimer(swapId: string): boolean {
    return this.timers.has(swapId);
  }

  /**
   * Cancels all active timers and clears internal state.
   *
   * Must be called on graceful shutdown to prevent timers from firing after
   * the orchestrator has been torn down.
   */
  destroy(): void {
    this.destroyed = true;
    for (const [swapId, entry] of this.timers) {
      clearTimeout(entry.handle);
      logger.debug({ swap_id: swapId }, 'Timer cleared on destroy');
    }
    this.timers.clear();
    logger.info('TimeoutManager destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Internal helper that creates the setTimeout, stores the entry, and wires
   * the fired callback to clear the timer reference (preventing memory leaks).
   */
  private _scheduleInternal(swapId: string, delayMs: number, deadlineMs: number): void {
    const handle = setTimeout(() => {
      if (this.destroyed) return;

      // Clear the timer reference before firing to prevent memory leaks
      // and allow hasTimer() to return false within the callback
      this.timers.delete(swapId);

      logger.info({ swap_id: swapId }, 'Swap timeout fired');

      this.onTimeout(swapId).catch((err: unknown) => {
        logger.error({ err, swap_id: swapId }, 'Error handling swap timeout');
      });
    }, delayMs);

    this.timers.set(swapId, { handle, deadlineMs });
  }
}
