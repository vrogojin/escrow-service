/**
 * CrashRecoveryManager
 *
 * Handles crash recovery by reconciling (swap state, invoice state) pairs
 * per architecture.md §Crash Recovery table.
 *
 * Called at startup via SwapOrchestrator.recoverSwaps() to restore in-flight
 * swaps to their correct state. Each non-terminal swap is inspected against
 * the AccountingModule's current invoice state and reconciled accordingly.
 *
 * Key design principle (persist-before-act): the SwapStateStore always reflects
 * the intended next action. Recovery reads from the store and resumes where
 * the last successful persist left off.
 */

import { logger } from '../utils/logger.js';
import { SwapState, isTerminalState } from './state-machine.js';
// Party identification is by currency slot, not sender address
import { isSphereError } from './accounting-types.js';
import type { InvoiceManager } from './invoice-manager.js';
import type { TimeoutManager } from './timeout-manager.js';
import type { SwapStateStore, SwapRecord } from './types.js';
import type { SwapOrchestrator } from './swap-orchestrator.js';
import type { InvoiceState } from './accounting-types.js';

export interface CrashRecoveryDeps {
  invoiceManager: InvoiceManager;
  stateStore: SwapStateStore;
  timeoutManager: TimeoutManager;
  /** Orchestrator reference — used to resume conclusion and re-subscribe to events. */
  orchestrator: SwapOrchestrator;
}

/**
 * Manages crash recovery for non-terminal swaps.
 */
export class CrashRecoveryManager {
  private readonly invoiceManager: InvoiceManager;
  private readonly stateStore: SwapStateStore;
  private readonly timeoutManager: TimeoutManager;
  private readonly orchestrator: SwapOrchestrator;

  constructor(deps: CrashRecoveryDeps) {
    this.invoiceManager = deps.invoiceManager;
    this.stateStore = deps.stateStore;
    this.timeoutManager = deps.timeoutManager;
    this.orchestrator = deps.orchestrator;
  }

  /**
   * Recovers all non-terminal swaps from the state store.
   *
   * Iterates all non-terminal swaps and reconciles each based on its
   * (swap state, invoice state) pair. Errors in individual swap recovery
   * are caught and logged — one bad swap does not block recovery of others.
   */
  async recover(): Promise<void> {
    const swaps = this.stateStore.findNonTerminal();
    logger.info({ count: swaps.length }, 'Starting crash recovery for non-terminal swaps');

    for (const swap of swaps) {
      try {
        await this.recoverSwap(swap);
      } catch (err) {
        logger.error({ err, swap_id: swap.swap_id, state: swap.state }, 'Failed to recover swap');
      }
    }

    logger.info({ count: swaps.length }, 'Crash recovery complete');
  }

  /**
   * Recovers a single swap by dispatching to the appropriate handler
   * based on the current swap state.
   *
   * @param swap - The SwapRecord to recover (from SwapStateStore).
   */
  async recoverSwap(swap: SwapRecord): Promise<void> {
    logger.info({ swap_id: swap.swap_id, state: swap.state }, 'Recovering swap');

    switch (swap.state) {
      case SwapState.ANNOUNCED:
        await this._recoverAnnounced(swap);
        break;

      case SwapState.DEPOSIT_INVOICE_CREATED:
        await this._recoverDepositInvoiceCreated(swap);
        break;

      case SwapState.PARTIAL_DEPOSIT:
        await this._recoverPartialDeposit(swap);
        break;

      case SwapState.DEPOSIT_COVERED:
        await this._recoverDepositCovered(swap);
        break;

      case SwapState.CONCLUDING:
        await this._recoverConcluding(swap);
        break;

      case SwapState.TIMED_OUT:
        await this._recoverTimedOut(swap);
        break;

      case SwapState.CANCELLING:
        await this._recoverCancelling(swap);
        break;

      default:
        if (isTerminalState(swap.state)) {
          logger.debug({ swap_id: swap.swap_id, state: swap.state }, 'Swap is terminal, no recovery needed');
        } else {
          logger.warn({ swap_id: swap.swap_id, state: swap.state }, 'Unknown non-terminal state, skipping recovery');
        }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-state recovery methods
  // ---------------------------------------------------------------------------

  /**
   * ANNOUNCED + (no invoice)
   *
   * Invoice creation failed or the store write was lost after createInvoice.
   * Re-create the deposit invoice by calling announce again.
   *
   * NOTE: If the crash occurred between createInvoice and updateState, a deposit
   * invoice may already exist in the AccountingModule but not in our swap record.
   * The SDK does not support querying invoices by swap metadata, so we cannot
   * detect this orphan. The orphaned invoice is harmless — no party has its ID,
   * so nobody will pay into it. It will remain in OPEN state until it expires.
   * A production enhancement could use a deterministic invoice ID derived from
   * swap_id to make re-creation idempotent.
   */
  private async _recoverAnnounced(swap: SwapRecord): Promise<void> {
    logger.info({ swap_id: swap.swap_id }, 'Recovery: ANNOUNCED — re-announcing swap (may create orphaned invoice if prior createInvoice succeeded but updateState did not)');
    try {
      await this.orchestrator.announce(swap.manifest);
    } catch (err) {
      logger.error({ err, swap_id: swap.swap_id }, 'Recovery: Failed to re-announce swap');
    }
  }

  /**
   * DEPOSIT_INVOICE_CREATED + (various invoice states)
   *
   * The invoice was created but the swap has not received any deposits yet.
   */
  private async _recoverDepositInvoiceCreated(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.error({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_INVOICE_CREATED but no deposit_invoice_id — treating as ANNOUNCED');
      await this._recoverAnnounced(swap);
      return;
    }

    let invoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      invoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        // Invoice token not loaded — treat as ANNOUNCED
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: Invoice not found in AccountingModule, re-announcing');
        await this._recoverAnnounced(swap);
        return;
      }
      throw err;
    }

    switch (invoiceState) {
      case 'OPEN':
        // Normal — re-subscribe to events, no deposit yet
        logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: DEPOSIT_INVOICE_CREATED + OPEN — waiting for deposits');
        // Global event subscription (already set up by start()) handles this
        break;

      case 'EXPIRED':
        // Invoice dueDate has passed. The escrow enforces timeout at the
        // application level (TimeoutManager), not via SDK dueDate.
        // However, if no deposit has ever arrived (first_deposit_at is null),
        // no timer is running and no event will ever advance this swap.
        // Use FAILED (valid from DEPOSIT_INVOICE_CREATED) to avoid immortal record.
        if (swap.first_deposit_at === null) {
          logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: DEPOSIT_INVOICE_CREATED + EXPIRED with zero deposits — failing swap');
          this._failSwap(swap, 'Invoice expired with zero deposits (no timer was running, swap would be immortal)');
        } else {
          // Deposits exist but state wasn't advanced to PARTIAL_DEPOSIT before crash.
          // Advance to PARTIAL_DEPOSIT first (so _handleTimeout can fire correctly),
          // then re-register the timeout.
          logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: DEPOSIT_INVOICE_CREATED + EXPIRED with deposits — advancing to PARTIAL_DEPOSIT');
          await this._advanceToPartialDeposit(swap);
        }
        break;

      case 'PARTIAL':
        // Partial deposit arrived during crash — treat same as PARTIAL_DEPOSIT recovery
        logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_INVOICE_CREATED + PARTIAL — advancing to PARTIAL_DEPOSIT');
        await this._advanceToPartialDeposit(swap);
        break;

      case 'COVERED':
        // Coverage achieved during crash — re-validate and resume conclusion
        logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_INVOICE_CREATED + COVERED — re-validating and concluding');
        await this._resumeConclusion(swap);
        break;

      case 'CLOSED':
        // Deposit closed without the escrow tracking it — manual intervention
        logger.error({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_INVOICE_CREATED + CLOSED — unexpected, transitioning to FAILED');
        this._failSwap(swap, 'Deposit invoice closed unexpectedly while in DEPOSIT_INVOICE_CREATED state');
        break;

      case 'CANCELLED':
        // Manual or unexpected cancellation before any deposit
        logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_INVOICE_CREATED + CANCELLED — transitioning to CANCELLED');
        this._cancelSwap(swap);
        break;

      default:
        logger.warn({ swap_id: swap.swap_id, invoiceState }, 'Recovery: Unknown invoice state for DEPOSIT_INVOICE_CREATED');
    }
  }

  /**
   * PARTIAL_DEPOSIT + (various invoice states)
   *
   * At least one deposit was received before the crash.
   */
  private async _recoverPartialDeposit(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.error({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT but no deposit_invoice_id');
      this._failSwap(swap, 'PARTIAL_DEPOSIT with no deposit_invoice_id');
      return;
    }

    let invoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      invoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        logger.error({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT but invoice not found');
        this._failSwap(swap, 'PARTIAL_DEPOSIT invoice not found in AccountingModule');
        return;
      }
      throw err;
    }

    switch (invoiceState) {
      case 'PARTIAL':
      case 'OPEN':
        // Re-register timeout with remaining time and re-subscribe
        logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: PARTIAL_DEPOSIT + PARTIAL/OPEN — re-registering timeout');
        this._reRegisterTimeout(swap);
        break;

      case 'EXPIRED':
        // dueDate passed but escrow timeout hasn't fired yet — treat as PARTIAL
        logger.info({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT + EXPIRED — re-registering timeout');
        this._reRegisterTimeout(swap);
        break;

      case 'COVERED':
        // Coverage achieved during crash — re-validate and resume conclusion
        logger.info({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT + COVERED — re-validating and concluding');
        await this._resumeConclusion(swap);
        break;

      case 'CLOSED':
        // Deposit closed with only partial coverage — unexpected
        logger.error({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT + CLOSED — unexpected, transitioning to FAILED');
        this._failSwap(swap, 'Deposit invoice closed unexpectedly with partial deposits');
        break;

      case 'CANCELLED':
        // Timeout fired during crash
        logger.info({ swap_id: swap.swap_id }, 'Recovery: PARTIAL_DEPOSIT + CANCELLED — transitioning to CANCELLED');
        this._cancelSwap(swap);
        break;

      default:
        logger.warn({ swap_id: swap.swap_id, invoiceState }, 'Recovery: Unknown invoice state for PARTIAL_DEPOSIT');
    }
  }

  /**
   * DEPOSIT_COVERED + (various invoice states)
   *
   * Coverage was confirmed but conclusion hadn't started before the crash.
   */
  private async _recoverDepositCovered(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.error({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED but no deposit_invoice_id');
      this._failSwap(swap, 'DEPOSIT_COVERED with no deposit_invoice_id');
      return;
    }

    let invoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      invoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        logger.error({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED but invoice not found');
        this._failSwap(swap, 'DEPOSIT_COVERED invoice not found in AccountingModule');
        return;
      }
      throw err;
    }

    switch (invoiceState) {
      case 'OPEN':
      case 'PARTIAL':
      case 'EXPIRED':
        // Coverage regressed during crash window — re-validate
        logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: DEPOSIT_COVERED + regressed invoice state — re-validating');
        await this._revalidateCoverageOrRevert(swap);
        break;

      case 'COVERED':
        // Still covered — proceed to conclusion
        logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED + COVERED — proceeding to conclusion');
        await this._resumeConclusion(swap);
        break;

      case 'CLOSED':
        // Deposit closed — payouts may not have been created yet
        logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED + CLOSED — creating payouts if missing');
        await this._concludeFromClosed(swap);
        break;

      case 'CANCELLED':
        // Deposit cancelled after coverage (e.g., admin action during crash)
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED + CANCELLED — checking auto-returns');
        await this._recoverCancelledAfterCoverage(swap);
        break;

      default:
        logger.warn({ swap_id: swap.swap_id, invoiceState }, 'Recovery: Unknown invoice state for DEPOSIT_COVERED');
    }
  }

  /**
   * CONCLUDING + (various invoice states)
   *
   * Payouts were created (or partially) before the crash.
   */
  private async _recoverConcluding(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.error({ swap_id: swap.swap_id }, 'Recovery: CONCLUDING but no deposit_invoice_id');
      this._failSwap(swap, 'CONCLUDING with no deposit_invoice_id');
      return;
    }

    let depositInvoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      depositInvoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        // Invoice not loaded — assume CLOSED (crash after close, before payout)
        depositInvoiceState = 'CLOSED';
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: CONCLUDING — deposit invoice not found, assuming CLOSED');
      } else {
        throw err;
      }
    }

    switch (depositInvoiceState) {
      case 'CLOSED':
        // Normal: deposit closed, now need to check/resume payouts
        await this._resumePayouts(swap);
        break;

      case 'OPEN':
      case 'PARTIAL':
      case 'COVERED':
      case 'EXPIRED':
        // Deposit not yet closed — close it first then resume payouts
        logger.info({ swap_id: swap.swap_id, depositInvoiceState }, 'Recovery: CONCLUDING — deposit invoice not yet closed, closing');
        try {
          await this.invoiceManager.closeDepositInvoice(swap.deposit_invoice_id);
        } catch (err) {
          if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CLOSED') {
            // Already closed — continue to payouts
          } else if (isSphereError(err) && err.code === 'INVOICE_NOT_TARGET') {
            // Transient SDK condition (addresses not loaded) — do NOT proceed
            // to _resumePayouts with deposit unclosed. Leave in CONCLUDING
            // for next recovery cycle to retry.
            logger.warn({ swap_id: swap.swap_id }, 'Recovery: CONCLUDING — closeDepositInvoice got INVOICE_NOT_TARGET (transient), will retry on next cycle');
            return;
          } else if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CANCELLED') {
            logger.error({ swap_id: swap.swap_id }, 'Recovery: CONCLUDING — deposit was cancelled, transitioning to FAILED');
            this._failSwap(swap, 'Deposit invoice cancelled while swap was CONCLUDING');
            return;
          } else {
            throw err;
          }
        }
        await this._resumePayouts(swap);
        break;

      case 'CANCELLED':
        logger.error({ swap_id: swap.swap_id }, 'Recovery: CONCLUDING + CANCELLED — deposit was cancelled, transitioning to FAILED');
        this._failSwap(swap, 'Deposit invoice cancelled while swap was CONCLUDING');
        break;

      default:
        logger.warn({ swap_id: swap.swap_id, depositInvoiceState }, 'Recovery: Unknown deposit invoice state for CONCLUDING');
    }
  }

  /**
   * TIMED_OUT + any invoice state
   *
   * Timeout was persisted but cancelInvoice may not have been called.
   * Idempotently cancel the invoice.
   */
  private async _recoverTimedOut(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.warn({ swap_id: swap.swap_id }, 'Recovery: TIMED_OUT but no deposit_invoice_id, transitioning to CANCELLED');
      const cancelling = this.stateStore.updateState(swap.swap_id, SwapState.CANCELLING, {}, swap.version);
      if (!cancelling) {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: TIMED_OUT — version mismatch on CANCELLING (no invoice)');
        return;
      }
      this._cancelSwap(cancelling);
      return;
    }

    // Check invoice state first — coverage may have won the race
    let invoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      invoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        // Invoice gone — transition to CANCELLED
        const cancelling = this.stateStore.updateState(swap.swap_id, SwapState.CANCELLING, {}, swap.version);
        if (cancelling) this._cancelSwap(cancelling);
        return;
      }
      throw err;
    }

    if (invoiceState === 'COVERED' || invoiceState === 'CLOSED') {
      // Coverage won the race — close the invoice (if not already closed),
      // contest TIMED_OUT → DEPOSIT_COVERED, and resume conclusion.
      logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: TIMED_OUT — coverage won race, resuming conclusion');
      if (invoiceState === 'COVERED') {
        try {
          await this.invoiceManager.closeDepositInvoice(swap.deposit_invoice_id);
        } catch (err) {
          if (isSphereError(err) && (err.code === 'INVOICE_ALREADY_CLOSED' || err.code === 'INVOICE_NOT_TARGET')) {
            // Already closed or transient SDK condition — proceed
          } else {
            throw err;
          }
        }
      }
      // Contest TIMED_OUT → DEPOSIT_COVERED
      const coveredSwap = this.stateStore.updateState(
        swap.swap_id,
        SwapState.DEPOSIT_COVERED,
        {},
        swap.version,
      );
      if (coveredSwap) {
        await this._resumePayouts(coveredSwap);
      } else {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: TIMED_OUT — version mismatch contesting to DEPOSIT_COVERED');
      }
      return;
    }

    logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: TIMED_OUT — cancelling invoice');

    // Transition to CANCELLING before calling cancelInvoice
    const cancelling = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CANCELLING,
      {},
      swap.version,
    );
    if (!cancelling) {
      logger.warn({ swap_id: swap.swap_id }, 'Recovery: TIMED_OUT — version mismatch on CANCELLING transition');
      return;
    }

    try {
      await this.invoiceManager.cancelDepositInvoice(swap.deposit_invoice_id);
      // invoice:cancelled event will fire and drive CANCELLING → CANCELLED
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CANCELLED') {
        // Already cancelled — transition directly to CANCELLED
        this._cancelSwap(cancelling);
      } else if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CLOSED') {
        // Coverage won after we checked — contest to DEPOSIT_COVERED and resume
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: TIMED_OUT — invoice closed during cancel, coverage won');
        const coveredSwap = this.stateStore.updateState(
          cancelling.swap_id,
          SwapState.DEPOSIT_COVERED,
          {},
          cancelling.version,
        );
        if (coveredSwap) {
          await this._resumePayouts(coveredSwap);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * CANCELLING + any invoice state
   *
   * cancelInvoice was called but the invoice:cancelled event may not have fired.
   */
  private async _recoverCancelling(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      logger.warn({ swap_id: swap.swap_id }, 'Recovery: CANCELLING but no deposit_invoice_id, transitioning to CANCELLED');
      this._cancelSwap(swap);
      return;
    }

    logger.info({ swap_id: swap.swap_id }, 'Recovery: CANCELLING — checking invoice state');

    let invoiceState: InvoiceState;
    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      invoiceState = status.state;
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        // Assume cancelled
        this._cancelSwap(swap);
        return;
      }
      throw err;
    }

    if (invoiceState === 'CANCELLED') {
      this._cancelSwap(swap);
    } else if (invoiceState === 'COVERED' || invoiceState === 'CLOSED') {
      // Coverage won the race — close invoice if needed, contest to DEPOSIT_COVERED,
      // and resume conclusion.
      logger.info({ swap_id: swap.swap_id, invoiceState }, 'Recovery: CANCELLING — coverage won race, resuming conclusion');
      if (invoiceState === 'COVERED') {
        try {
          await this.invoiceManager.closeDepositInvoice(swap.deposit_invoice_id);
        } catch (err) {
          if (isSphereError(err) && (err.code === 'INVOICE_ALREADY_CLOSED' || err.code === 'INVOICE_NOT_TARGET')) {
            // Already closed or transient SDK condition — proceed
          } else {
            throw err;
          }
        }
      }
      // Contest CANCELLING → DEPOSIT_COVERED (state machine permits this).
      // Uses _resumePayouts (not _concludeSwap) to avoid re-creating payout
      // invoices that may already exist from a partial prior conclusion attempt.
      const coveredSwap = this.stateStore.updateState(
        swap.swap_id,
        SwapState.DEPOSIT_COVERED,
        {},
        swap.version,
      );
      if (coveredSwap) {
        await this._resumePayouts(coveredSwap);
      } else {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: CANCELLING — version mismatch contesting to DEPOSIT_COVERED');
      }
    } else {
      // Invoice not yet cancelled — retry cancelInvoice
      try {
        await this.invoiceManager.cancelDepositInvoice(swap.deposit_invoice_id);
        // invoice:cancelled event will drive CANCELLING → CANCELLED
      } catch (err) {
        if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CANCELLED') {
          this._cancelSwap(swap);
        } else if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CLOSED') {
          // Coverage won after we checked — contest to DEPOSIT_COVERED
          logger.warn({ swap_id: swap.swap_id }, 'Recovery: CANCELLING — invoice closed during cancel, coverage won');
          const coveredSwap = this.stateStore.updateState(
            swap.swap_id,
            SwapState.DEPOSIT_COVERED,
            {},
            swap.version,
          );
          if (coveredSwap) {
            await this._resumePayouts(coveredSwap);
          }
        } else {
          throw err;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Advances a DEPOSIT_INVOICE_CREATED swap to PARTIAL_DEPOSIT when the
   * invoice shows PARTIAL state (a deposit arrived during crash window).
   */
  private async _advanceToPartialDeposit(swap: SwapRecord): Promise<void> {
    // Use the invoice's lastActivityAt as the best approximation of first
    // deposit time (it's updated on each payment), falling back to now.
    // This prevents the timeout window from being artificially extended by
    // the duration of the crash outage.
    let firstDepositAt = Date.now();
    if (swap.deposit_invoice_id) {
      try {
        const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
        if (status.lastActivityAt) {
          firstDepositAt = status.lastActivityAt;
        }
      } catch {
        // Fall back to now if status retrieval fails
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: could not retrieve invoice status for deposit timestamp, using now');
      }
    }
    const timeoutAt = firstDepositAt + swap.manifest.timeout * 1000;

    const updated = this.stateStore.updateState(
      swap.swap_id,
      SwapState.PARTIAL_DEPOSIT,
      { first_deposit_at: firstDepositAt, timeout_at: timeoutAt },
      swap.version,
    );

    if (updated) {
      this._reRegisterTimeout(updated);
    }
  }

  /**
   * Re-validates per-party coverage and resumes conclusion, or reverts to
   * PARTIAL_DEPOSIT if coverage no longer holds.
   *
   * Used when invoice state is COVERED but we need to verify the correct
   * parties paid the correct currencies via their senderAddresses.
   */
  private async _resumeConclusion(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      this._failSwap(swap, 'Cannot resume conclusion: no deposit_invoice_id');
      return;
    }

    let status: Awaited<ReturnType<typeof this.invoiceManager.getInvoiceStatus>>;
    try {
      status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        logger.error({ swap_id: swap.swap_id }, 'Recovery: _resumeConclusion — deposit invoice not found, transitioning to FAILED');
        this._failSwap(swap, 'Deposit invoice not found when resuming conclusion');
        return;
      }
      logger.error({ err, swap_id: swap.swap_id }, 'Recovery: _resumeConclusion — unexpected error fetching invoice status, will retry next cycle');
      return;
    }

    const target = status.targets[0];
    if (!target) {
      this._failSwap(swap, 'Cannot resume conclusion: invoice has no targets');
      return;
    }

    const assetA = target.coinAssets[0];
    const assetB = target.coinAssets[1];

    if (!assetA || !assetB) {
      this._failSwap(swap, 'Cannot resume conclusion: invoice missing coin assets');
      return;
    }

    // Currency-slot coverage: check that each asset slot has forward payments with matching coinId
    const slotACovered = assetA.transfers.some(
      (t) =>
        t.paymentDirection === 'forward' &&
        t.coinId === swap.manifest.party_a_currency_to_change,
    );

    const slotBCovered = assetB.transfers.some(
      (t) =>
        t.paymentDirection === 'forward' &&
        t.coinId === swap.manifest.party_b_currency_to_change,
    );

    if (!slotACovered || !slotBCovered) {
      // Coverage doesn't meet per-currency-slot validation.
      // DEPOSIT_COVERED can only transition to CONCLUDING or FAILED (not PARTIAL_DEPOSIT).
      // Transition to FAILED — operator must manually verify coverage and intervene.
      logger.error(
        { swap_id: swap.swap_id, slotACovered, slotBCovered },
        'Recovery: DEPOSIT_COVERED currency-slot coverage validation failed — transitioning to FAILED (manual intervention required)',
      );
      this._failSwap(swap, `Currency-slot coverage validation failed in DEPOSIT_COVERED recovery (A: ${slotACovered}, B: ${slotBCovered})`);
      return;
    }

    // Valid coverage — transition to DEPOSIT_COVERED then conclude
    const coveredSwap = this.stateStore.updateState(
      swap.swap_id,
      SwapState.DEPOSIT_COVERED,
      {},
      swap.version,
    );

    if (!coveredSwap) {
      logger.warn({ swap_id: swap.swap_id }, 'Recovery: Version mismatch on DEPOSIT_COVERED transition');
      return;
    }

    // Close deposit invoice if not already closed
    if (status.state !== 'CLOSED') {
      try {
        await this.invoiceManager.closeDepositInvoice(swap.deposit_invoice_id);
      } catch (err) {
        if (isSphereError(err) && (err.code === 'INVOICE_ALREADY_CLOSED' || err.code === 'INVOICE_NOT_TARGET')) {
          // Already closed or transient SDK condition — proceed
        } else if (isSphereError(err) && err.code === 'INVOICE_ALREADY_CANCELLED') {
          logger.error({ swap_id: swap.swap_id }, 'Recovery: Invoice was cancelled, failing swap');
          this._failSwap(coveredSwap, 'Invoice was cancelled when attempting to close during recovery');
          return;
        } else {
          throw err;
        }
      }
    }

    // Route through _resumePayouts (not _concludeSwap) to avoid explicit
    // amounts in payInvoice — recovery must omit amount so SDK computes
    // remaining, preventing double-payment if a prior attempt partially paid.
    await this._resumePayouts(coveredSwap);
  }

  /**
   * Handles DEPOSIT_COVERED + CLOSED recovery.
   * Deposit was closed but payout invoices may not have been created yet.
   * Always routes through _resumePayouts to use amount-omitting payInvoice.
   */
  private async _concludeFromClosed(swap: SwapRecord): Promise<void> {
    logger.info({ swap_id: swap.swap_id }, 'Recovery: DEPOSIT_COVERED + CLOSED — resuming payouts');
    await this._resumePayouts(swap);
  }

  /**
   * Handles DEPOSIT_COVERED + CANCELLED recovery.
   * Checks whether deposits were auto-returned and decides CANCELLED vs FAILED.
   */
  private async _recoverCancelledAfterCoverage(swap: SwapRecord): Promise<void> {
    // Without direct access to the auto-return ledger from here, we transition
    // to FAILED for manual intervention per architecture.md §Crash Recovery:
    // "partially returned or no returns, transition to FAILED for manual intervention"
    //
    // A production implementation with access to the auto-return ledger entries
    // could inspect them to determine if all amounts were returned.
    logger.error(
      { swap_id: swap.swap_id },
      'Recovery: DEPOSIT_COVERED + CANCELLED — transitioning to FAILED for manual intervention',
    );
    this._failSwap(swap, 'Deposit invoice cancelled after coverage was confirmed; manual intervention required');
  }

  /**
   * Resumes paying payout invoices from CONCLUDING state.
   *
   * Per architecture.md §Crash Recovery (partial payout recovery):
   * - Omit the amount parameter when retrying payInvoice (SDK computes remaining)
   * - Catch INVOICE_INVALID_AMOUNT (remaining = 0, success)
   * - Catch INVOICE_TERMINATED (already closed/cancelled, success)
   * - Catch INVOICE_NOT_FOUND (import token, retry)
   */
  private async _resumePayouts(swap: SwapRecord): Promise<void> {
    const manifest = swap.manifest;

    // Fetch the latest persisted swap record to get the most current version
    // and payout invoice IDs (the caller may have passed a stale record).
    let currentSwap = this.stateStore.findBySwapId(swap.swap_id);
    if (!currentSwap) {
      logger.error({ swap_id: swap.swap_id }, 'Recovery: Swap not found when resuming payouts');
      return;
    }

    // Read payout IDs from the CURRENT store record, not the stale caller argument.
    // A prior partial recovery may have already persisted payout_a_invoice_id.
    let payoutAId = currentSwap.payout_a_invoice_id;
    let payoutBId = currentSwap.payout_b_invoice_id;

    // If payout A is missing, create it and immediately persist its ID.
    // Persisting before creating payout B ensures that, if we crash between
    // the two creations, recovery will skip A on the next pass and only create B.
    if (!payoutAId) {
      const result = await this.invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        currentSwap.resolved_party_a_address,
        manifest.party_b_currency_to_change,
        manifest.party_b_value_to_change,
        'A',
      );
      if (!result.success || !result.invoiceId) {
        this._failSwap(currentSwap, `Recovery: Failed to create payout A invoice: ${result.error ?? 'unknown'}`);
        return;
      }
      payoutAId = result.invoiceId;

      // Persist payout A ID immediately (still in current state) before creating B.
      // This prevents double-creation of payout A on a subsequent crash.
      const afterA = this.stateStore.updateState(
        swap.swap_id,
        currentSwap.state,
        { payout_a_invoice_id: payoutAId },
        currentSwap.version,
      );
      if (!afterA) {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: Version mismatch persisting payout A invoice ID, aborting');
        return;
      }
      currentSwap = afterA;
    }

    // If payout B is missing, create it.
    if (!payoutBId) {
      const result = await this.invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        currentSwap.resolved_party_b_address,
        manifest.party_a_currency_to_change,
        manifest.party_a_value_to_change,
        'B',
      );
      if (!result.success || !result.invoiceId) {
        this._failSwap(currentSwap, `Recovery: Failed to create payout B invoice: ${result.error ?? 'unknown'}`);
        return;
      }
      payoutBId = result.invoiceId;
    }

    // Persist CONCLUDING with both payout IDs (idempotent if already there).
    if (currentSwap.state !== SwapState.CONCLUDING) {
      const concluding = this.stateStore.updateState(
        swap.swap_id,
        SwapState.CONCLUDING,
        {
          payout_a_invoice_id: payoutAId,
          payout_b_invoice_id: payoutBId,
        },
        currentSwap.version,
      );
      if (!concluding) {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: Version mismatch updating CONCLUDING');
        return;
      }
      currentSwap = concluding;
    } else if (!currentSwap.payout_b_invoice_id) {
      // Already CONCLUDING but payout B ID not yet persisted — update it now.
      const updated = this.stateStore.updateState(
        swap.swap_id,
        SwapState.CONCLUDING,
        {
          payout_a_invoice_id: payoutAId,
          payout_b_invoice_id: payoutBId,
        },
        currentSwap.version,
      );
      if (!updated) {
        logger.warn({ swap_id: swap.swap_id }, 'Recovery: Version mismatch updating payout B invoice ID');
        return;
      }
      currentSwap = updated;
    }

    logger.info({ swap_id: swap.swap_id, payoutAId, payoutBId }, 'Recovery: Resuming payout payments');

    // Pay payout A (omit amount — SDK computes remaining)
    await this._retryPayInvoice(swap.swap_id, payoutAId, 0, 0);

    // Pay payout B (omit amount — SDK computes remaining)
    await this._retryPayInvoice(swap.swap_id, payoutBId, 0, 0);

    // Transition to COMPLETED
    const reloaded = this.stateStore.findBySwapId(swap.swap_id);
    if (!reloaded) return;

    const completed = this.stateStore.updateState(
      swap.swap_id,
      SwapState.COMPLETED,
      { completed_at: Date.now() },
      reloaded.version,
    );

    if (completed) {
      logger.info({ swap_id: swap.swap_id }, 'Recovery: Swap completed after payout retry');
    }
  }

  /**
   * Retry-safe payInvoice wrapper for crash recovery.
   *
   * Per architecture.md §Crash Recovery (partial payout):
   * - Omit amount so SDK sends only the uncovered remainder
   * - INVOICE_INVALID_AMOUNT = already covered = success
   * - INVOICE_TERMINATED = invoice closed/cancelled = success
   * - INVOICE_NOT_FOUND = payout token missing — throws so the swap stays in
   *   CONCLUDING and is not falsely transitioned to COMPLETED (operator must
   *   manually import the token and retry)
   */
  private async _retryPayInvoice(
    swapId: string,
    invoiceId: string,
    targetIndex: number,
    assetIndex: number,
  ): Promise<void> {
    try {
      // Omit amount — SDK computes remaining
      await this.invoiceManager.payInvoice(invoiceId, { targetIndex, assetIndex });
    } catch (err) {
      if (isSphereError(err)) {
        if (err.code === 'INVOICE_INVALID_AMOUNT') {
          // Remaining = 0 — already paid
          logger.info({ swap_id: swapId, invoiceId }, 'Recovery: payInvoice — already covered (INVOICE_INVALID_AMOUNT)');
          return;
        }
        if (err.code === 'INVOICE_TERMINATED') {
          // Invoice already closed/cancelled — treat as success
          logger.info({ swap_id: swapId, invoiceId }, 'Recovery: payInvoice — invoice terminated (INVOICE_TERMINATED)');
          return;
        }
        if (err.code === 'INVOICE_NOT_FOUND') {
          // Token not loaded in AccountingModule after restart.
          // We cannot safely treat this as success — the payout has NOT been made.
          // Throwing here prevents _resumePayouts from transitioning to COMPLETED
          // and leaves the swap in CONCLUDING for operator intervention.
          throw new Error(`Payout invoice not found — manual intervention required: ${invoiceId}`);
        }
      }
      logger.error({ err, swap_id: swapId, invoiceId }, 'Recovery: payInvoice — unexpected error');
      throw err;
    }
  }

  /**
   * Re-validates per-party coverage for DEPOSIT_COVERED + regressed invoice state.
   * If coverage is still valid from the correct parties, proceeds to conclusion.
   * Otherwise, reverts to PARTIAL_DEPOSIT and re-registers timeout.
   */
  private async _revalidateCoverageOrRevert(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) {
      this._failSwap(swap, 'Cannot revalidate: no deposit_invoice_id');
      return;
    }

    let status: Awaited<ReturnType<typeof this.invoiceManager.getInvoiceStatus>>;
    try {
      status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
    } catch (err) {
      if (isSphereError(err) && err.code === 'INVOICE_NOT_FOUND') {
        logger.error({ swap_id: swap.swap_id }, 'Recovery: _revalidateCoverageOrRevert — deposit invoice not found, transitioning to FAILED');
        this._failSwap(swap, 'Deposit invoice not found when revalidating coverage');
        return;
      }
      logger.error({ err, swap_id: swap.swap_id }, 'Recovery: _revalidateCoverageOrRevert — unexpected error fetching invoice status, will retry next cycle');
      return;
    }

    const target = status.targets[0];
    if (!target) {
      this._failSwap(swap, 'Cannot revalidate: invoice has no targets');
      return;
    }

    const assetA = target.coinAssets[0];
    const assetB = target.coinAssets[1];

    if (!assetA || !assetB) {
      this._failSwap(swap, 'Cannot revalidate: invoice missing coin assets');
      return;
    }

    // Check if each currency slot's net contribution still meets the threshold
    const slotAAmount = assetA.transfers
      .filter(
        (t) =>
          t.paymentDirection === 'forward' &&
          t.coinId === swap.manifest.party_a_currency_to_change,
      )
      .reduce((sum, t) => BigInt(sum) + BigInt(t.amount), 0n);

    const slotBAmount = assetB.transfers
      .filter(
        (t) =>
          t.paymentDirection === 'forward' &&
          t.coinId === swap.manifest.party_b_currency_to_change,
      )
      .reduce((sum, t) => BigInt(sum) + BigInt(t.amount), 0n);

    const requiredA = BigInt(swap.manifest.party_a_value_to_change);
    const requiredB = BigInt(swap.manifest.party_b_value_to_change);

    if (slotAAmount >= requiredA && slotBAmount >= requiredB) {
      // Still covered — close the deposit invoice first, then conclude
      logger.info({ swap_id: swap.swap_id }, 'Recovery: Coverage still valid, closing invoice and proceeding to conclusion');
      if (swap.deposit_invoice_id) {
        try {
          await this.invoiceManager.closeDepositInvoice(swap.deposit_invoice_id);
        } catch (err) {
          if (isSphereError(err) && (err.code === 'INVOICE_ALREADY_CLOSED' || err.code === 'INVOICE_NOT_TARGET')) {
            logger.info({ swap_id: swap.swap_id }, 'Recovery: Deposit invoice already closed or transient NOT_TARGET');
          } else {
            throw err;
          }
        }
      }
      await this._concludeFromClosed(swap);
    } else {
      // Coverage regressed — DEPOSIT_COVERED can only go to CONCLUDING or FAILED.
      // Transition to FAILED — operator must manually verify and intervene.
      logger.error(
        { swap_id: swap.swap_id, slotAAmount: String(slotAAmount), slotBAmount: String(slotBAmount) },
        'Recovery: DEPOSIT_COVERED coverage regressed — transitioning to FAILED (manual intervention required)',
      );
      this._failSwap(swap, `Coverage regressed in DEPOSIT_COVERED recovery (A: ${String(slotAAmount)}/${String(requiredA)}, B: ${String(slotBAmount)}/${String(requiredB)})`);
    }
  }

  /**
   * Re-registers the timeout timer for a swap with remaining time computed
   * from the persisted timeout_at.
   */
  private _reRegisterTimeout(swap: SwapRecord): void {
    const now = Date.now();
    const timeoutAt = swap.timeout_at ?? now + swap.manifest.timeout * 1000;
    const remainingMs = timeoutAt - now;

    logger.info(
      { swap_id: swap.swap_id, remainingMs, timeoutAt: new Date(timeoutAt).toISOString() },
      'Recovery: Re-registering timeout',
    );

    this.timeoutManager.reRegister(swap.swap_id, remainingMs);
  }

  /**
   * Synchronously transitions a swap to CANCELLED state.
   * Used during recovery when we know the invoice is already cancelled.
   */
  private _cancelSwap(swap: SwapRecord): void {
    const cancelled = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CANCELLED,
      {},
      swap.version,
    );
    if (cancelled) {
      logger.info({ swap_id: swap.swap_id }, 'Recovery: Swap transitioned to CANCELLED');
    }
  }

  /**
   * Synchronously transitions a swap to FAILED state.
   */
  private _failSwap(swap: SwapRecord, errorMessage: string): void {
    const failed = this.stateStore.updateState(
      swap.swap_id,
      SwapState.FAILED,
      { error_message: errorMessage },
      swap.version,
    );
    if (failed) {
      logger.error({ swap_id: swap.swap_id, error: errorMessage }, 'Recovery: Swap transitioned to FAILED');
    }
  }
}
