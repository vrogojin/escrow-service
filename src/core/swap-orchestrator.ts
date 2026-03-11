/**
 * SwapOrchestrator
 *
 * Central coordinator for the swap lifecycle. Subscribes to AccountingModule
 * events (via InvoiceManager) and drives state transitions in response.
 *
 * Key responsibilities:
 * - Announces swaps and creates deposit invoices
 * - Handles invoice:payment, invoice:covered, invoice:cancelled events
 * - Manages timeout via TimeoutManager
 * - Executes conclusion (close deposit, create payouts, pay payouts)
 * - Notifies parties via MessageSender
 * - Supports crash recovery via CrashRecoveryManager
 *
 * Per architecture.md §Security: runs as a single instance. The AccountingModule's
 * per-invoice async mutex is in-process only — multi-instance deployments would
 * require distributed locking.
 */

import { logger } from '../utils/logger.js';
import { SwapState, isTerminalState } from './state-machine.js';
import { validateManifest } from './manifest-validator.js';
import { validateDeposit, getEffectiveSender } from './deposit-validator.js';
import type { InvoiceManager } from './invoice-manager.js';
import type { TimeoutManager } from './timeout-manager.js';
import type { SwapStateStore, AnnounceResult, SwapRecord } from './types.js';
import type { SwapManifest } from './manifest-validator.js';
import type { InvoiceTransferRef } from './accounting-types.js';
import { isSphereError } from './accounting-types.js';
import { ManifestValidationError } from '../sphere/orchestrator-interfaces.js';
import { CrashRecoveryManager } from './crash-recovery-manager.js';

// =============================================================================
// Dependency interfaces
// =============================================================================

/**
 * Interface for sending DMs to swap parties.
 * The implementation is responsible for routing DMs to the correct Nostr pubkeys.
 */
export interface MessageSender {
  /**
   * Sends a DM to a swap party identified by their role.
   * @param swapId - The swap identifier (for routing lookup).
   * @param party - 'A' or 'B'.
   * @param message - JSON message payload.
   */
  sendToParty(swapId: string, party: 'A' | 'B', message: Record<string, unknown>): Promise<void>;

  /**
   * Sends a DM to a specific chain address.
   * @param address - The recipient's DIRECT:// address.
   * @param message - JSON message payload.
   */
  sendToAddress(address: string, message: Record<string, unknown>): Promise<void>;
}

/**
 * Interface for resolving manifest party addresses to DIRECT:// format.
 * Supports DIRECT://, PROXY://, and @nametag address formats.
 */
export interface AddressResolver {
  /**
   * Resolves an address to its DIRECT:// form.
   * @param address - A DIRECT://, PROXY://, or @nametag address.
   * @returns The resolved DIRECT:// address, or null if resolution fails.
   */
  resolve(address: string): Promise<string | null>;
}

export interface SwapOrchestratorDeps {
  invoiceManager: InvoiceManager;
  stateStore: SwapStateStore;
  timeoutManager: TimeoutManager;
  messageSender: MessageSender;
  addressResolver: AddressResolver;
}

// =============================================================================
// Event payload types (matching SphereEventMap)
// =============================================================================

interface InvoicePaymentPayload {
  invoiceId: string;
  transfer: InvoiceTransferRef;
  paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  confirmed: boolean;
}

interface InvoiceCoveredPayload {
  invoiceId: string;
  confirmed: boolean;
}

interface InvoiceCancelledPayload {
  invoiceId: string;
}

// =============================================================================
// SwapOrchestrator
// =============================================================================

/**
 * Central coordinator for the swap lifecycle.
 */
export class SwapOrchestrator {
  private readonly invoiceManager: InvoiceManager;
  private readonly stateStore: SwapStateStore;
  private readonly timeoutManager: TimeoutManager;
  private readonly messageSender: MessageSender;
  private readonly addressResolver: AddressResolver;
  private readonly crashRecovery: CrashRecoveryManager;

  /** Bound event handlers — stored as instance properties so they can be unsubscribed. */
  private readonly handlePayment: (payload: InvoicePaymentPayload) => void;
  private readonly handleCovered: (payload: InvoiceCoveredPayload) => void;
  private readonly handleCancelled: (payload: InvoiceCancelledPayload) => void;

  /** Per-invoice bounce counter for rate limiting wrong-currency bounces. */
  private readonly bounceCounters = new Map<string, { count: number; windowStart: number }>();
  private static readonly MAX_BOUNCES_PER_MINUTE = 10;

  private started = false;

  constructor(deps: SwapOrchestratorDeps) {
    this.invoiceManager = deps.invoiceManager;
    this.stateStore = deps.stateStore;
    this.timeoutManager = deps.timeoutManager;
    this.messageSender = deps.messageSender;
    this.addressResolver = deps.addressResolver;

    this.crashRecovery = new CrashRecoveryManager({
      invoiceManager: this.invoiceManager,
      stateStore: this.stateStore,
      timeoutManager: this.timeoutManager,
      orchestrator: this,
    });

    // Bind handlers so the same reference can be passed to on() and off()
    this.handlePayment = (payload) => {
      this._onInvoicePayment(payload).catch((err) => {
        logger.error({ err, invoiceId: payload.invoiceId }, 'Error handling invoice:payment');
      });
    };
    this.handleCovered = (payload) => {
      this._onInvoiceCovered(payload).catch((err) => {
        logger.error({ err, invoiceId: payload.invoiceId }, 'Error handling invoice:covered');
      });
    };
    this.handleCancelled = (payload) => {
      this._onInvoiceCancelled(payload).catch((err) => {
        logger.error({ err, invoiceId: payload.invoiceId }, 'Error handling invoice:cancelled');
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts listening to invoice events from the InvoiceManager.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.invoiceManager.on('invoice:payment', this.handlePayment);
    this.invoiceManager.on('invoice:covered', this.handleCovered);
    this.invoiceManager.on('invoice:cancelled', this.handleCancelled);

    logger.info('SwapOrchestrator started');
  }

  /**
   * Stops listening to invoice events and destroys the timeout manager.
   *
   * Should be called on graceful shutdown.
   */
  async stop(): Promise<void> {
    this.invoiceManager.off('invoice:payment', this.handlePayment);
    this.invoiceManager.off('invoice:covered', this.handleCovered);
    this.invoiceManager.off('invoice:cancelled', this.handleCancelled);

    this.timeoutManager.destroy();
    this.started = false;

    logger.info('SwapOrchestrator stopped');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Processes a swap manifest announcement.
   *
   * If a swap with the same swap_id already exists, returns the existing swap
   * case without creating a new invoice. This prevents duplicate swap cases.
   *
   * Steps:
   * 1. Validate manifest
   * 2. Check for existing swap
   * 3. Resolve party addresses to DIRECT://
   * 4. Create swap record (ANNOUNCED)
   * 5. Create deposit invoice
   * 6. Update swap with deposit_invoice_id (→ DEPOSIT_INVOICE_CREATED)
   * 7. Subscribe to invoice events (global subscription handles all invoices)
   * 8. Return result
   *
   * @param manifest - The swap manifest to announce.
   * @returns AnnounceResult with the swap_id, deposit_invoice_id, and is_new flag.
   * @throws Error if manifest is invalid, address resolution fails, or invoice creation fails.
   */
  async announce(manifest: SwapManifest, _announcerNpub?: string): Promise<AnnounceResult> {
    // 1. Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new ManifestValidationError(validation.errors);
    }

    // 2. Check for existing swap
    const existing = this.stateStore.findBySwapId(manifest.swap_id);
    if (existing) {
      // If swap is in ANNOUNCED state (invoice creation may have failed), re-attempt
      if (existing.state === SwapState.ANNOUNCED) {
        logger.info({ swap_id: manifest.swap_id }, 'Existing swap in ANNOUNCED state, re-attempting invoice creation');
        return this._createDepositInvoiceForSwap(existing);
      }

      // Return existing swap case
      if (!existing.deposit_invoice_id) {
        throw new Error(`Swap ${manifest.swap_id} exists in state ${existing.state} but has no deposit_invoice_id`);
      }

      logger.info({ swap_id: manifest.swap_id, state: existing.state }, 'Returning existing swap case');
      return {
        swap_id: existing.swap_id,
        deposit_invoice_id: existing.deposit_invoice_id,
        is_new: false,
      };
    }

    // 3. Resolve party addresses to DIRECT://
    const [resolvedA, resolvedB] = await Promise.all([
      this.addressResolver.resolve(manifest.party_a_address),
      this.addressResolver.resolve(manifest.party_b_address),
    ]);

    if (!resolvedA) {
      throw new Error(`Cannot resolve party A address: ${manifest.party_a_address}`);
    }
    if (!resolvedB) {
      throw new Error(`Cannot resolve party B address: ${manifest.party_b_address}`);
    }

    // 4. Create swap record in ANNOUNCED state
    const swap = this.stateStore.create(manifest, { partyA: resolvedA, partyB: resolvedB });

    // 5 & 6. Create deposit invoice and transition to DEPOSIT_INVOICE_CREATED
    return this._createDepositInvoiceForSwap(swap);
  }

  /**
   * Recovers non-terminal swaps on startup.
   *
   * Delegates to CrashRecoveryManager which reconciles (swap state, invoice state) pairs
   * per architecture.md §Crash Recovery table.
   */
  async recoverSwaps(): Promise<void> {
    await this.crashRecovery.recover();
  }

  // ---------------------------------------------------------------------------
  // Internal: announce helpers
  // ---------------------------------------------------------------------------

  /**
   * Creates the deposit invoice for an existing swap record.
   * Used both during initial announce and when re-attempting after failure.
   */
  private async _createDepositInvoiceForSwap(swap: SwapRecord): Promise<AnnounceResult> {
    const result = await this.invoiceManager.createDepositInvoice(swap.manifest);

    if (!result.success || !result.invoiceId) {
      const errMsg = result.error ?? 'Unknown invoice creation error';
      throw new Error(`Invoice creation failed: ${errMsg}`);
    }

    // Update swap to DEPOSIT_INVOICE_CREATED with the invoice ID
    const updated = this.stateStore.updateState(
      swap.swap_id,
      SwapState.DEPOSIT_INVOICE_CREATED,
      { deposit_invoice_id: result.invoiceId },
      swap.version,
    );

    if (!updated) {
      // Version mismatch — another concurrent announce succeeded
      const reloaded = this.stateStore.findBySwapId(swap.swap_id);
      if (reloaded?.deposit_invoice_id) {
        logger.warn({ swap_id: swap.swap_id }, 'Concurrent announce won the race, returning existing invoice');
        return {
          swap_id: reloaded.swap_id,
          deposit_invoice_id: reloaded.deposit_invoice_id,
          is_new: false,
        };
      }
      throw new Error(`Failed to persist deposit invoice ID for swap ${swap.swap_id}`);
    }

    logger.info(
      { swap_id: swap.swap_id, invoiceId: result.invoiceId },
      'Swap announced, deposit invoice created',
    );

    return {
      swap_id: swap.swap_id,
      deposit_invoice_id: result.invoiceId,
      is_new: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: event handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles the invoice:payment event.
   *
   * Per architecture.md §Event-Driven Flow (invoice:payment):
   * 1. Look up swap by deposit invoice ID
   * 2. State guard: ignore if TIMED_OUT or later
   * 3. Validate currency via identifyPartySide() using coinId
   * 4. If wrong currency: returnPayment() using effectiveSender as recipient
   * 5. If first valid deposit: transition to PARTIAL_DEPOSIT, start timeout
   */
  async _onInvoicePayment(payload: InvoicePaymentPayload): Promise<void> {
    const { invoiceId, transfer, paymentDirection } = payload;

    // Only process forward payments (not returns/bounces)
    if (paymentDirection !== 'forward') {
      return;
    }

    const swap = this.stateStore.findByInvoiceId(invoiceId);
    if (!swap) {
      logger.debug({ invoiceId }, 'invoice:payment — no swap found for invoice');
      return;
    }

    // Only handle events for the deposit invoice
    if (swap.deposit_invoice_id !== invoiceId) {
      return;
    }

    // State guard: ignore if swap is TIMED_OUT or in a terminal state
    if (
      swap.state === SwapState.TIMED_OUT ||
      swap.state === SwapState.CANCELLING ||
      isTerminalState(swap.state)
    ) {
      logger.debug(
        { swap_id: swap.swap_id, state: swap.state },
        'invoice:payment — swap is in non-accepting state, ignoring',
      );
      return;
    }

    // State guard: ignore if already covered or concluding.
    // Do NOT attempt to bounce — the deposit invoice is already closed (or being
    // closed) by _onInvoiceCovered(), so returnInvoicePayment would fail.
    // Late payments on a closed invoice are handled by the SDK's auto-return.
    if (
      swap.state === SwapState.DEPOSIT_COVERED ||
      swap.state === SwapState.CONCLUDING
    ) {
      logger.debug(
        { swap_id: swap.swap_id, state: swap.state, transferId: transfer.transferId },
        'invoice:payment — deposit already covered/concluding, ignoring (SDK handles auto-return on closed invoice)',
      );
      return;
    }

    // Validate the deposit — party side is determined by currency, not sender
    const validation = validateDeposit(transfer, swap.manifest);

    if (validation.reason === 'WRONG_CURRENCY') {
      if (!this._checkBounceRateLimit(invoiceId)) {
        logger.warn(
          { swap_id: swap.swap_id, transferId: transfer.transferId, coinId: transfer.coinId },
          'invoice:payment — wrong currency bounce rate-limited, deferred to cancel/close auto-return',
        );
        return;
      }
      logger.warn(
        {
          swap_id: swap.swap_id,
          transferId: transfer.transferId,
          coinId: transfer.coinId,
        },
        'invoice:payment — wrong currency, bouncing',
      );
      await this._bouncePayment(swap, invoiceId, transfer, 'WRONG_CURRENCY');
      return;
    }

    // Valid deposit — check if this is the first one
    const isFirstDeposit =
      swap.state === SwapState.DEPOSIT_INVOICE_CREATED && swap.first_deposit_at === null;

    if (isFirstDeposit) {
      const now = Date.now();
      const timeoutAt = now + swap.manifest.timeout * 1000;

      const updated = this.stateStore.updateState(
        swap.swap_id,
        SwapState.PARTIAL_DEPOSIT,
        { first_deposit_at: now, timeout_at: timeoutAt },
        swap.version,
      );

      if (updated) {
        // Start the timeout timer — guard against a timer already registered
        // (e.g., crash recovery called reRegister() before this handler ran).
        if (this.timeoutManager.hasTimer(swap.swap_id)) {
          logger.debug(
            { swap_id: swap.swap_id },
            'Timeout timer already exists (crash recovery re-registered) — skipping schedule()',
          );
        } else {
          this.timeoutManager.schedule(swap.swap_id, swap.manifest.timeout * 1000);
        }
        logger.info(
          {
            swap_id: swap.swap_id,
            partySide: validation.partySide,
            coinId: transfer.coinId,
            amount: transfer.amount,
          },
          'First valid deposit received, timeout timer started',
        );
      } else {
        logger.warn({ swap_id: swap.swap_id }, 'Version mismatch on first deposit state transition');
      }
    } else {
      logger.info(
        {
          swap_id: swap.swap_id,
          partySide: validation.partySide,
          coinId: transfer.coinId,
          amount: transfer.amount,
          state: swap.state,
        },
        'Valid deposit received (not first)',
      );
    }
  }

  /**
   * Handles the invoice:covered event.
   *
   * Per architecture.md §Event-Driven Flow (invoice:covered):
   * 1. Look up swap, state guard
   * 2. Re-validate per-currency-slot coverage (coinId matches asset index)
   * 3. Transition to DEPOSIT_COVERED (bounded CAS retry; also contests TIMED_OUT)
   * 4. Close deposit invoice (no autoReturn)
   * 5. Cancel timeout timer (AFTER close succeeds)
   * 6. Create payout invoices A and B (via _concludeSwap)
   * 7. Persist as CONCLUDING with payout IDs BEFORE paying
   * 8. Pay both payout invoices
   * 9. Send payment_confirmation DMs
   * 10. Transition to COMPLETED
   */
  async _onInvoiceCovered(payload: InvoiceCoveredPayload): Promise<void> {
    const { invoiceId } = payload;

    const swap = this.stateStore.findByInvoiceId(invoiceId);
    if (!swap || swap.deposit_invoice_id !== invoiceId) {
      logger.debug({ invoiceId }, 'invoice:covered — no deposit swap found for invoice');
      return;
    }

    // State guard: proceed if the swap is in a state where coverage can be applied.
    // TIMED_OUT and CANCELLING are included because coverage can contest a timeout —
    // the CAS retry loop below handles TIMED_OUT/CANCELLING → DEPOSIT_COVERED
    // transitions (coverage wins the race per architecture spec).
    if (
      swap.state !== SwapState.DEPOSIT_INVOICE_CREATED &&
      swap.state !== SwapState.PARTIAL_DEPOSIT &&
      swap.state !== SwapState.TIMED_OUT &&
      swap.state !== SwapState.CANCELLING
    ) {
      logger.debug(
        { swap_id: swap.swap_id, state: swap.state },
        'invoice:covered — swap not in accepting state, ignoring (idempotent)',
      );
      return;
    }

    // Re-validate per-currency-slot coverage with amount thresholds:
    // the SDK's invoice:covered means both asset slots are fully covered.
    // We verify each slot's cumulative forward amount meets the manifest's
    // required value. Sender identity is NOT checked — anyone can deposit
    // on behalf of A or B.
    let invoiceStatus;
    try {
      invoiceStatus = await this.invoiceManager.getInvoiceStatus(invoiceId);
    } catch (err) {
      // C6 fix: if getInvoiceStatus fails, log and return so crash recovery
      // or a subsequent event can retry. Do NOT consume the covered event
      // silently — the swap must not become a zombie.
      logger.error(
        { err, swap_id: swap.swap_id, invoiceId },
        'invoice:covered — failed to fetch invoice status, will rely on crash recovery',
      );
      return;
    }
    const target = invoiceStatus.targets[0];
    if (!target) {
      logger.error({ swap_id: swap.swap_id }, 'invoice:covered — no target in invoice status');
      return;
    }

    const assetA = target.coinAssets[0]; // party_a_currency
    const assetB = target.coinAssets[1]; // party_b_currency

    if (!assetA || !assetB) {
      logger.error({ swap_id: swap.swap_id }, 'invoice:covered — missing coin assets in invoice status');
      return;
    }

    // Validate each slot's cumulative forward amount meets the required value
    const slotAAmount = assetA.transfers
      .filter(
        (t) => t.paymentDirection === 'forward' &&
               t.coinId === swap.manifest.party_a_currency_to_change,
      )
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);

    const slotBAmount = assetB.transfers
      .filter(
        (t) => t.paymentDirection === 'forward' &&
               t.coinId === swap.manifest.party_b_currency_to_change,
      )
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);

    const requiredA = BigInt(swap.manifest.party_a_value_to_change);
    const requiredB = BigInt(swap.manifest.party_b_value_to_change);

    if (slotAAmount < requiredA || slotBAmount < requiredB) {
      logger.warn(
        {
          swap_id: swap.swap_id,
          slotAAmount: String(slotAAmount),
          slotBAmount: String(slotBAmount),
          requiredA: String(requiredA),
          requiredB: String(requiredB),
        },
        'invoice:covered — per-slot amount coverage validation failed, waiting',
      );
      return;
    }

    // 3. Transition to DEPOSIT_COVERED
    let coveredSwap = this.stateStore.updateState(
      swap.swap_id,
      SwapState.DEPOSIT_COVERED,
      {},
      swap.version,
    );

    if (!coveredSwap) {
      // CAS failed — a concurrent handler modified the swap.
      // Retry in a bounded loop (up to 3 attempts total including the first).
      // Also accept TIMED_OUT as a contestable state: if coverage arrives while
      // timeout handling is in progress, coverage wins (SDK confirmed it).
      const MAX_CAS_ATTEMPTS = 3;
      let attempt = 1; // first attempt already done above
      while (attempt < MAX_CAS_ATTEMPTS) {
        attempt++;
        const reloaded = this.stateStore.findBySwapId(swap.swap_id);
        if (!reloaded) return;

        if (
          reloaded.state === SwapState.DEPOSIT_INVOICE_CREATED ||
          reloaded.state === SwapState.PARTIAL_DEPOSIT
        ) {
          // A payment handler won the race (e.g., advanced to PARTIAL_DEPOSIT).
          // Retry the DEPOSIT_COVERED CAS with the reloaded version.
          coveredSwap = this.stateStore.updateState(
            reloaded.swap_id,
            SwapState.DEPOSIT_COVERED,
            {},
            reloaded.version,
          );
          if (coveredSwap) break;
          logger.debug(
            { swap_id: swap.swap_id, attempt },
            'invoice:covered — DEPOSIT_COVERED CAS retry failed, re-attempting',
          );
        } else if (reloaded.state === SwapState.TIMED_OUT || reloaded.state === SwapState.CANCELLING) {
          // Timeout handler won the state transition race, but coverage arrived
          // before cancellation completed. Coverage wins — contest TIMED_OUT or
          // CANCELLING. Both transitions are valid per the state machine.
          coveredSwap = this.stateStore.updateState(
            reloaded.swap_id,
            SwapState.DEPOSIT_COVERED,
            {},
            reloaded.version,
          );
          if (coveredSwap) {
            break;
          }
          logger.debug(
            { swap_id: swap.swap_id, attempt, fromState: reloaded.state },
            'invoice:covered — DEPOSIT_COVERED CAS from timeout/cancelling retry failed, re-attempting',
          );
        } else {
          // Already advanced past any contestable state (DEPOSIT_COVERED, CONCLUDING, COMPLETED, etc.)
          logger.info(
            { swap_id: swap.swap_id, state: reloaded.state },
            'invoice:covered — swap already advanced past accepting state, ignoring',
          );
          return;
        }
      }

      if (!coveredSwap) {
        logger.warn(
          { swap_id: swap.swap_id, attempts: MAX_CAS_ATTEMPTS },
          'invoice:covered — DEPOSIT_COVERED CAS exhausted all retries, another handler will handle',
        );
        return;
      }

    }

    // 4. Close deposit invoice (no autoReturn) BEFORE cancelling the timer.
    // Cancelling the timer first would leave the swap stuck in DEPOSIT_COVERED
    // forever if closeDepositInvoice throws a transient error — the timer would
    // be gone and no retry mechanism would fire.
    try {
      await this.invoiceManager.closeDepositInvoice(invoiceId);
    } catch (err) {
      if (isSphereError(err)) {
        if (err.code === 'INVOICE_ALREADY_CLOSED') {
          // Already closed — proceed to payout creation
          logger.info({ swap_id: swap.swap_id }, 'Deposit invoice already closed, proceeding to payouts');
        } else if (err.code === 'INVOICE_NOT_TARGET') {
          // SDK's getActiveAddresses() may return empty if tracked addresses
          // haven't loaded yet. The escrow IS the target (we created the invoice).
          // Proceed — the invoice will be implicitly closed when we stop accepting payments.
          logger.warn(
            { swap_id: swap.swap_id },
            'closeDepositInvoice returned INVOICE_NOT_TARGET (addresses not yet loaded), proceeding to payouts',
          );
        } else if (err.code === 'INVOICE_ALREADY_CANCELLED') {
          // Timeout won the race — the invoice is cancelled and deposits are
          // being auto-returned. We cannot proceed with conclusion. The swap is
          // currently in DEPOSIT_COVERED (we transitioned it above). Transition
          // to FAILED for manual reconciliation — crash recovery handles
          // DEPOSIT_COVERED + CANCELLED via _recoverCancelledAfterCoverage.
          // Timer is still active here; it will fire but the swap is no longer
          // in PARTIAL_DEPOSIT so _handleTimeout will ignore it.
          logger.error(
            { swap_id: swap.swap_id },
            'Deposit invoice cancelled (timeout won race) while swap is DEPOSIT_COVERED — transitioning to FAILED',
          );
          await this._transitionToFailed(
            coveredSwap,
            'Deposit invoice cancelled by timeout while in DEPOSIT_COVERED; deposits auto-returned',
          );
          return;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    // 5. Cancel timeout timer AFTER closeDepositInvoice succeeds.
    // If close threw a transient error (and we returned/threw above), the timer
    // remains active and will eventually fire to handle the swap.
    this.timeoutManager.cancel(swap.swap_id);

    // 6 & 7. Create payout invoices and pay
    await this._concludeSwap(coveredSwap);
  }

  /**
   * Handles the invoice:cancelled event.
   *
   * Only advances the swap from CANCELLING → CANCELLED.
   * Auto-return continues asynchronously after this event.
   */
  async _onInvoiceCancelled(payload: InvoiceCancelledPayload): Promise<void> {
    const { invoiceId } = payload;

    const swap = this.stateStore.findByInvoiceId(invoiceId);
    if (!swap || swap.deposit_invoice_id !== invoiceId) {
      logger.debug({ invoiceId }, 'invoice:cancelled — no deposit swap found for invoice');
      return;
    }

    if (swap.state !== SwapState.CANCELLING) {
      logger.debug(
        { swap_id: swap.swap_id, state: swap.state },
        'invoice:cancelled — swap not in CANCELLING state, ignoring',
      );
      return;
    }

    const cancelled = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CANCELLED,
      {},
      swap.version,
    );

    if (cancelled) {
      this._cleanupSwapResources(swap);
      logger.info({ swap_id: swap.swap_id }, 'Swap cancelled (auto-return continues asynchronously)');

      // Notify both parties
      await this._notifyBothParties(swap.swap_id, {
        type: 'swap_cancelled',
        swap_id: swap.swap_id,
        reason: 'timeout',
        deposits_returned: true,
      });
    }
  }

  /**
   * Timeout handler — passed to TimeoutManager as the onTimeout callback.
   *
   * Per architecture.md §Persistence Ordering: persist TIMED_OUT BEFORE
   * calling cancelInvoice.
   */
  async _handleTimeout(swapId: string): Promise<void> {
    const swap = this.stateStore.findBySwapId(swapId);
    if (!swap) {
      logger.warn({ swap_id: swapId }, 'Timeout fired for unknown swap');
      return;
    }

    // Only proceed if the swap is still in PARTIAL_DEPOSIT.
    // The timeout timer is only scheduled on first deposit (→ PARTIAL_DEPOSIT),
    // so DEPOSIT_INVOICE_CREATED should never reach here via the timer. If it
    // does (e.g., stale re-registration), ignore it — there are no deposits to refund.
    if (swap.state !== SwapState.PARTIAL_DEPOSIT) {
      logger.info(
        { swap_id: swapId, state: swap.state },
        'Timeout fired but swap already advanced, ignoring',
      );
      return;
    }

    // Persist TIMED_OUT BEFORE calling cancelInvoice (persist-before-act)
    const timedOut = this.stateStore.updateState(
      swapId,
      SwapState.TIMED_OUT,
      {},
      swap.version,
    );

    if (!timedOut) {
      logger.warn({ swap_id: swapId }, 'Version mismatch transitioning to TIMED_OUT');
      return;
    }

    if (!swap.deposit_invoice_id) {
      logger.error({ swap_id: swapId }, 'Cannot cancel invoice: deposit_invoice_id is null');
      await this._transitionToFailed(timedOut, 'Timeout with no deposit invoice ID');
      return;
    }

    // Transition to CANCELLING
    const cancelling = this.stateStore.updateState(
      swapId,
      SwapState.CANCELLING,
      {},
      timedOut.version,
    );

    if (!cancelling) {
      logger.warn({ swap_id: swapId }, 'Version mismatch transitioning to CANCELLING');
      return;
    }

    // Cancel the invoice — fires invoice:cancelled event, then begins auto-return
    try {
      await this.invoiceManager.cancelDepositInvoice(swap.deposit_invoice_id);
    } catch (err) {
      if (isSphereError(err)) {
        if (err.code === 'INVOICE_ALREADY_CANCELLED') {
          // Already cancelled — fire the cancelled event logic manually
          logger.info({ swap_id: swapId }, 'Invoice already cancelled on timeout handler');
          await this._onInvoiceCancelled({ invoiceId: swap.deposit_invoice_id });
          return;
        } else if (err.code === 'INVOICE_NOT_TARGET') {
          // SDK's getActiveAddresses() may return empty (transient condition).
          // Do NOT fake a cancelled event — the invoice is still live.
          // Leave in CANCELLING for crash recovery to retry cancelInvoice.
          logger.warn(
            { swap_id: swapId },
            'cancelInvoice returned INVOICE_NOT_TARGET (transient) — leaving in CANCELLING for crash recovery',
          );
          return;
        } else if (err.code === 'INVOICE_ALREADY_CLOSED') {
          // Coverage won the race — the invoice was closed (covered) before
          // cancelInvoice could run. _onInvoiceCovered must have already
          // CAS'd to DEPOSIT_COVERED (closeInvoice happens AFTER the CAS),
          // so it owns the conclusion path. Any CAS attempt here with
          // cancelling.version would fail because the version already advanced.
          // Nothing to do — _onInvoiceCovered handles conclusion.
          logger.info(
            { swap_id: swapId },
            'Invoice already closed (coverage won race) — _onInvoiceCovered owns conclusion, no action needed',
          );
          return;
        }
      }
      logger.error({ err, swap_id: swapId }, 'Failed to cancel invoice on timeout — leaving in CANCELLING for crash recovery to retry');
      // Do NOT transition to FAILED — the deposit invoice is still live.
      // Crash recovery will retry cancelInvoice for swaps in CANCELLING state.
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: conclusion
  // ---------------------------------------------------------------------------

  /**
   * Executes the conclusion phase for a covered swap.
   *
   * Step sequence (persist-before-act ordering throughout):
   * 1. CAS to CONCLUDING FIRST — this gates all payout invoice creation
   *    on winning the state transition, preventing orphaned payout invoices.
   * 2. Create payout invoice A
   *    - If fails → leave in CONCLUDING, crash recovery retries
   * 3. Create payout invoice B
   *    - If fails → persist payout_a_invoice_id into CONCLUDING, leave for crash recovery
   * 4. Persist both payout IDs into the CONCLUDING record
   * 5. Pay payout A (omit amount — SDK computes remaining for idempotency)
   *    - If fails → leave in CONCLUDING, crash recovery retries
   * 6. Pay payout B (omit amount)
   *    - If fails → leave in CONCLUDING, crash recovery retries
   * 7. Return surplus (best-effort)
   * 8. Send payment_confirmation DMs
   * 9. Transition to COMPLETED
   */
  async _concludeSwap(swap: SwapRecord): Promise<void> {
    const manifest = swap.manifest;

    // Step 1: CAS to CONCLUDING FIRST.
    // Gate all payout invoice creation on winning this CAS. This prevents
    // orphaned payout invoices: if another handler wins the CAS, we never
    // create payout invoices at all.
    const currentSwap = this.stateStore.findBySwapId(swap.swap_id);
    if (!currentSwap) {
      logger.error({ swap_id: swap.swap_id }, 'Swap not found when transitioning to CONCLUDING');
      return;
    }

    const concluding = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CONCLUDING,
      {},
      currentSwap.version,
    );

    if (!concluding) {
      const recheck = this.stateStore.findBySwapId(swap.swap_id);
      if (recheck?.state === SwapState.CONCLUDING || isTerminalState(recheck?.state as SwapState)) {
        logger.info(
          { swap_id: swap.swap_id, state: recheck?.state },
          'Another handler already advanced the swap — deferring to winner',
        );
      } else {
        logger.error(
          { swap_id: swap.swap_id, currentState: recheck?.state },
          'Version mismatch persisting CONCLUDING — swap in unexpected state',
        );
      }
      return;
    }

    // Step 2: Create payout invoice A — party A receives party B's currency.
    // We are now the CONCLUDING owner. If creation fails, leave in CONCLUDING
    // for crash recovery. Do NOT transition to FAILED.
    const payoutAResult = await this.invoiceManager.createPayoutInvoice(
      manifest.swap_id,
      swap.resolved_party_a_address,
      manifest.party_b_currency_to_change,
      manifest.party_b_value_to_change,
      'A',
    );

    if (!payoutAResult.success || !payoutAResult.invoiceId) {
      const errMsg = payoutAResult.error ?? 'Unknown payout A invoice creation error';
      logger.error(
        { swap_id: swap.swap_id, error: errMsg },
        'Failed to create payout A invoice — leaving in CONCLUDING for crash recovery',
      );
      return;
    }

    const payoutAId = payoutAResult.invoiceId;

    // Checkpoint payout A ID immediately so crash recovery knows not to
    // re-create it if we crash before creating payout B.
    const afterCheckpointA = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CONCLUDING,
      { payout_a_invoice_id: payoutAId },
      concluding.version,
    );
    if (!afterCheckpointA) {
      logger.warn({ swap_id: swap.swap_id, payoutAId }, 'Version mismatch checkpointing payout A ID');
      return;
    }

    // Step 3: Create payout invoice B — party B receives party A's currency.
    const payoutBResult = await this.invoiceManager.createPayoutInvoice(
      manifest.swap_id,
      swap.resolved_party_b_address,
      manifest.party_a_currency_to_change,
      manifest.party_a_value_to_change,
      'B',
    );

    if (!payoutBResult.success || !payoutBResult.invoiceId) {
      const errMsg = payoutBResult.error ?? 'Unknown payout B invoice creation error';
      logger.error(
        { swap_id: swap.swap_id, error: errMsg, payoutAId },
        'Failed to create payout B invoice — leaving in CONCLUDING for crash recovery',
      );
      return;
    }

    const payoutBId = payoutBResult.invoiceId;

    // Step 4: Checkpoint both payout IDs.
    const afterCheckpointB = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CONCLUDING,
      {
        payout_a_invoice_id: payoutAId,
        payout_b_invoice_id: payoutBId,
      },
      afterCheckpointA.version,
    );
    if (!afterCheckpointB) {
      logger.warn({ swap_id: swap.swap_id }, 'Version mismatch checkpointing payout B ID');
      return;
    }

    logger.info(
      { swap_id: swap.swap_id, payoutAId, payoutBId },
      'Swap concluding — paying payout invoices',
    );

    // Step 4: Pay payout A — targetIndex 0, assetIndex 0.
    // CRITICAL: Omit the `amount` parameter so the SDK computes
    // remaining = requestedAmount - netCoveredAmount. This makes the call
    // inherently idempotent: if payout A was already fully covered (e.g.,
    // crash recovery retry or duplicate event), remaining = 0 and the SDK
    // returns INVOICE_INVALID_AMOUNT. Passing an explicit amount would
    // bypass the zero-remaining guard and cause a double-payment.
    try {
      await this.invoiceManager.payInvoice(payoutAId, {
        targetIndex: 0,
        assetIndex: 0,
      });
    } catch (err) {
      if (isSphereError(err) && (err.code === 'INVOICE_TERMINATED' || err.code === 'INVOICE_INVALID_AMOUNT')) {
        logger.info({ swap_id: swap.swap_id, payoutAId }, 'Payout A already covered (idempotent)');
      } else {
        // Leave in CONCLUDING for crash recovery — do NOT call _transitionToFailed.
        logger.error(
          { err, swap_id: swap.swap_id, payoutAId, payoutBId },
          'Failed to pay payout A invoice — leaving in CONCLUDING for crash recovery',
        );
        return;
      }
    }

    // Step 5: Pay payout B — targetIndex 0, assetIndex 0.
    // Same idempotent pattern: omit amount so SDK computes remaining.
    try {
      await this.invoiceManager.payInvoice(payoutBId, {
        targetIndex: 0,
        assetIndex: 0,
      });
    } catch (err) {
      if (isSphereError(err) && (err.code === 'INVOICE_TERMINATED' || err.code === 'INVOICE_INVALID_AMOUNT')) {
        logger.info({ swap_id: swap.swap_id, payoutBId }, 'Payout B already covered (idempotent)');
      } else {
        // Payout A already succeeded — do NOT transition to FAILED.
        // Leave in CONCLUDING so crash recovery can retry payout B.
        logger.error(
          { err, swap_id: swap.swap_id, payoutAId, payoutBId },
          'Failed to pay payout B (payout A already succeeded) — leaving in CONCLUDING for crash recovery',
        );
        return;
      }
    }

    // Best-effort surplus return to original depositors
    await this._returnSurplus(swap);

    // Send payment_confirmation DMs to both parties
    await this._sendPaymentConfirmations(swap.swap_id, manifest, payoutAId, payoutBId);

    // Transition to COMPLETED
    const reloaded = this.stateStore.findBySwapId(swap.swap_id);
    if (!reloaded) {
      logger.error({ swap_id: swap.swap_id }, 'Swap not found when transitioning to COMPLETED');
      return;
    }

    const completed = this.stateStore.updateState(
      swap.swap_id,
      SwapState.COMPLETED,
      { completed_at: Date.now() },
      reloaded.version,
    );

    if (completed) {
      this._cleanupSwapResources(reloaded);
      logger.info({ swap_id: swap.swap_id }, 'Swap completed successfully');
    } else {
      logger.warn({ swap_id: swap.swap_id }, 'Version mismatch transitioning to COMPLETED (likely already completed)');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------------

  /**
   * Checks and increments the per-invoice bounce counter.
   * Returns true if the bounce is allowed, false if rate-limited.
   */
  private _checkBounceRateLimit(invoiceId: string): boolean {
    const now = Date.now();
    const counter = this.bounceCounters.get(invoiceId);

    if (!counter || now - counter.windowStart > 60_000) {
      // New window
      this.bounceCounters.set(invoiceId, { count: 1, windowStart: now });
      return true;
    }

    if (counter.count >= SwapOrchestrator.MAX_BOUNCES_PER_MINUTE) {
      return false;
    }

    counter.count++;
    return true;
  }

  /**
   * Returns surplus deposits to their original payers after a successful swap.
   *
   * After payouts complete, the deposit invoice may hold surplus amounts
   * (overpayment by any depositor). This method iterates senderBalances for
   * each coin asset and returns any positive netBalance to the effectiveSender.
   *
   * Best-effort: failures are logged but do not block COMPLETED transition.
   */
  private async _returnSurplus(swap: SwapRecord): Promise<void> {
    if (!swap.deposit_invoice_id) return;

    try {
      const status = await this.invoiceManager.getInvoiceStatus(swap.deposit_invoice_id);
      const target = status.targets[0];
      if (!target) return;

      for (const coinAsset of target.coinAssets) {
        // senderBalances is typed as unknown[] in our duck-typed interface.
        // The SDK's InvoiceSenderBalance.senderAddress IS the effectiveSender
        // (refundAddress ?? senderAddress) — see SDK types.ts:155-162.
        const senderBalances = coinAsset.senderBalances as Array<{
          senderAddress: string; // effectiveSender per SDK contract
          netBalance: string;
        }>;
        if (!Array.isArray(senderBalances)) continue;

        for (const sb of senderBalances) {
          const netBalance = BigInt(sb.netBalance || '0');
          if (netBalance <= 0n) continue;

          // There's surplus for this sender — compute how much is surplus
          // (netBalance = forwarded - returned). After payouts, any remaining
          // netBalance in the deposit invoice is surplus.
          // We need to know how much was consumed by payouts vs. what remains.
          // The SDK's senderBalances.netBalance already accounts for returns.
          // Any positive netBalance AFTER payouts means unclaimed surplus.

          try {
            await this.invoiceManager.returnPayment(swap.deposit_invoice_id, {
              recipient: sb.senderAddress,
              amount: netBalance.toString(),
              coinId: coinAsset.coin[0],
              freeText: `Surplus return for swap ${swap.swap_id}`,
            });
            logger.info(
              {
                swap_id: swap.swap_id,
                recipient: sb.senderAddress,
                coinId: coinAsset.coin[0],
                amount: netBalance.toString(),
              },
              'Surplus returned to depositor',
            );
          } catch (err) {
            // Best-effort — log but don't block completion
            logger.warn(
              {
                err,
                swap_id: swap.swap_id,
                recipient: sb.senderAddress,
                coinId: coinAsset.coin[0],
                amount: netBalance.toString(),
              },
              'Failed to return surplus to depositor (best-effort)',
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, swap_id: swap.swap_id },
        'Failed to query deposit invoice status for surplus return (best-effort)',
      );
    }
  }

  /**
   * Bounces an unauthorized or incorrect payment back to its sender.
   *
   * Uses effectiveSender (refundAddress ?? senderAddress) as the return
   * address, since the SDK's returnInvoicePayment validates the balance cap
   * against senderBalances keyed by effectiveSender.
   *
   * If there is no return address (masked predicate with no refundAddress),
   * logs a warning — manual intervention required.
   */
  private async _bouncePayment(
    swap: SwapRecord,
    invoiceId: string,
    transfer: InvoiceTransferRef,
    reason: 'WRONG_CURRENCY',
  ): Promise<void> {
    const recipient = getEffectiveSender(transfer);

    if (!recipient) {
      logger.warn(
        {
          swap_id: swap.swap_id,
          transferId: transfer.transferId,
          reason,
        },
        'Cannot bounce payment: no return address (masked predicate with no refundAddress). Manual intervention required.',
      );
      return;
    }

    // Return the payment — propagate errors so callers know the bounce failed.
    // This is a funds-movement operation; silent failure would trap funds.
    try {
      await this.invoiceManager.returnPayment(invoiceId, {
        recipient,
        amount: transfer.amount,
        coinId: transfer.coinId,
        freeText: `Bounce: ${reason}`,
      });
    } catch (err) {
      if (isSphereError(err) && (
        err.code === 'INVOICE_ALREADY_CLOSED' ||
        err.code === 'INVOICE_ALREADY_CANCELLED' ||
        err.code === 'INVOICE_RETURN_EXCEEDS_BALANCE'
      )) {
        // returnInvoicePayment can throw INVOICE_RETURN_EXCEEDS_BALANCE when the
        // sender has no remaining balance (e.g., already returned via auto-return
        // on cancel/close). The SDK does NOT throw INVOICE_ALREADY_CLOSED/CANCELLED
        // from returnInvoicePayment, but we handle them defensively in case of
        // future SDK changes. In all cases, the funds are handled by the SDK's
        // auto-return mechanism.
        logger.info(
          { swap_id: swap.swap_id, transferId: transfer.transferId, code: err.code },
          'Bounce unnecessary — payment handled by SDK auto-return or balance exhausted',
        );
        return;
      }
      logger.error(
        { err, swap_id: swap.swap_id, transferId: transfer.transferId, reason },
        'Failed to return payment (bounce) — funds may be recovered on invoice cancel/close',
      );
      // Re-throw so callers can handle the failure
      throw err;
    }

    logger.info(
      {
        swap_id: swap.swap_id,
        transferId: transfer.transferId,
        recipient,
        reason,
        coinId: transfer.coinId,
        amount: transfer.amount,
      },
      'Payment bounced',
    );

    // Notify the sender via DM — best-effort, do not let DM failure mask a successful bounce
    try {
      await this.messageSender.sendToAddress(recipient, {
        type: 'bounce_notification',
        swap_id: swap.swap_id,
        reason,
        returned_amount: transfer.amount,
        returned_currency: transfer.coinId,
      });
    } catch (dmErr) {
      logger.warn(
        { err: dmErr, swap_id: swap.swap_id, transferId: transfer.transferId },
        'Bounce succeeded but DM notification failed',
      );
    }
  }

  /**
   * Sends payment_confirmation DMs to both parties after payout.
   */
  private async _sendPaymentConfirmations(
    swapId: string,
    manifest: SwapManifest,
    payoutAId: string,
    payoutBId: string,
  ): Promise<void> {
    const sendA = this.messageSender.sendToParty(swapId, 'A', {
      type: 'payment_confirmation',
      swap_id: swapId,
      payout_invoice_id: payoutAId,
      currency: manifest.party_b_currency_to_change,
      amount: manifest.party_b_value_to_change,
      status: 'paid',
    });

    const sendB = this.messageSender.sendToParty(swapId, 'B', {
      type: 'payment_confirmation',
      swap_id: swapId,
      payout_invoice_id: payoutBId,
      currency: manifest.party_a_currency_to_change,
      amount: manifest.party_a_value_to_change,
      status: 'paid',
    });

    await Promise.allSettled([sendA, sendB]);
  }

  /**
   * Notifies both parties with the same message.
   */
  private async _notifyBothParties(swapId: string, message: Record<string, unknown>): Promise<void> {
    const [resA, resB] = await Promise.allSettled([
      this.messageSender.sendToParty(swapId, 'A', message),
      this.messageSender.sendToParty(swapId, 'B', message),
    ]);
    if (resA.status === 'rejected') {
      logger.warn({ err: resA.reason, swap_id: swapId }, 'Failed to notify party A');
    }
    if (resB.status === 'rejected') {
      logger.warn({ err: resB.reason, swap_id: swapId }, 'Failed to notify party B');
    }
  }

  /**
   * Transitions a swap to FAILED state and notifies both parties.
   */
  /**
   * Clean up per-swap in-memory resources (bounce counters, timers) when
   * a swap reaches a terminal state to prevent unbounded memory growth.
   */
  private _cleanupSwapResources(swap: SwapRecord): void {
    if (swap.deposit_invoice_id) {
      this.bounceCounters.delete(swap.deposit_invoice_id);
    }
    this.timeoutManager.cancel(swap.swap_id);
  }

  private async _transitionToFailed(swap: SwapRecord, errorMessage: string): Promise<void> {
    const failed = this.stateStore.updateState(
      swap.swap_id,
      SwapState.FAILED,
      { error_message: errorMessage },
      swap.version,
    );

    if (failed) {
      this._cleanupSwapResources(swap);
      logger.error({ swap_id: swap.swap_id, error: errorMessage }, 'Swap transitioned to FAILED');

      await this._notifyBothParties(swap.swap_id, {
        type: 'error',
        swap_id: swap.swap_id,
        error: 'Swap failed due to an internal error. Please contact support.',
        details: [errorMessage],
      });
    }
  }
}
