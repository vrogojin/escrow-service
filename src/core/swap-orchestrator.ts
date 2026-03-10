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
import { validateDeposit, getEffectiveSender, identifyParty } from './deposit-validator.js';
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
   * 3. Validate sender via identifyParty() using senderAddress (cryptographic)
   * 4. If invalid: returnPayment() using effectiveSender as recipient
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

    // Validate the sender
    const validation = validateDeposit(
      transfer,
      swap.resolved_party_a_address,
      swap.resolved_party_b_address,
      swap.manifest,
    );

    if (validation.reason === 'MASKED_PREDICATE') {
      // Cannot verify identity — bounce if effectiveSender is available
      logger.warn(
        { swap_id: swap.swap_id, transferId: transfer.transferId },
        'invoice:payment — masked predicate sender, cannot verify identity',
      );
      await this._bouncePayment(swap, invoiceId, transfer, 'UNKNOWN_SENDER');
      return;
    }

    if (validation.reason === 'UNKNOWN_SENDER') {
      logger.warn(
        { swap_id: swap.swap_id, transferId: transfer.transferId, senderAddress: transfer.senderAddress },
        'invoice:payment — unknown sender, bouncing',
      );
      await this._bouncePayment(swap, invoiceId, transfer, 'UNKNOWN_SENDER');
      return;
    }

    if (validation.reason === 'WRONG_CURRENCY') {
      logger.warn(
        {
          swap_id: swap.swap_id,
          transferId: transfer.transferId,
          party: validation.party,
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
        // Start the timeout timer
        this.timeoutManager.schedule(swap.swap_id, swap.manifest.timeout * 1000);
        logger.info(
          {
            swap_id: swap.swap_id,
            party: validation.party,
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
          party: validation.party,
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
   * 2. Re-validate per-party coverage using senderAddress from transfers
   * 3. Transition to DEPOSIT_COVERED, cancel timeout
   * 4. Close deposit invoice (no autoReturn)
   * 5. Create payout invoices
   * 6. Persist as CONCLUDING with payout IDs BEFORE paying
   * 7. Pay both payout invoices
   * 8. Send payment_confirmation DMs
   * 9. Transition to COMPLETED
   */
  async _onInvoiceCovered(payload: InvoiceCoveredPayload): Promise<void> {
    const { invoiceId } = payload;

    const swap = this.stateStore.findByInvoiceId(invoiceId);
    if (!swap || swap.deposit_invoice_id !== invoiceId) {
      logger.debug({ invoiceId }, 'invoice:covered — no deposit swap found for invoice');
      return;
    }

    // State guard: only proceed if DEPOSIT_INVOICE_CREATED or PARTIAL_DEPOSIT
    if (
      swap.state !== SwapState.DEPOSIT_INVOICE_CREATED &&
      swap.state !== SwapState.PARTIAL_DEPOSIT
    ) {
      logger.debug(
        { swap_id: swap.swap_id, state: swap.state },
        'invoice:covered — swap not in accepting state, ignoring (idempotent)',
      );
      return;
    }

    // Re-validate per-party coverage: iterate coinAssets[i].transfers and check
    // that party A contributed to asset 0 and party B contributed to asset 1
    const invoiceStatus = await this.invoiceManager.getInvoiceStatus(invoiceId);
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

    // Validate asset 0: party A must have covered it with their address
    const partyACoverage = assetA.transfers.some(
      (t) => t.paymentDirection === 'forward' &&
             t.senderAddress !== null &&
             identifyParty(t.senderAddress, swap.resolved_party_a_address, swap.resolved_party_b_address) === 'A' &&
             t.coinId === swap.manifest.party_a_currency_to_change,
    );

    // Validate asset 1: party B must have covered it with their address
    const partyBCoverage = assetB.transfers.some(
      (t) => t.paymentDirection === 'forward' &&
             t.senderAddress !== null &&
             identifyParty(t.senderAddress, swap.resolved_party_a_address, swap.resolved_party_b_address) === 'B' &&
             t.coinId === swap.manifest.party_b_currency_to_change,
    );

    if (!partyACoverage || !partyBCoverage) {
      logger.warn(
        {
          swap_id: swap.swap_id,
          partyACoverage,
          partyBCoverage,
        },
        'invoice:covered — coverage not validated per party, waiting for correct payment',
      );

      // Best-effort bounce of unauthorized payments that caused false coverage.
      // Continue bouncing remaining transfers even if one bounce fails.
      for (const transfer of assetA.transfers) {
        if (transfer.paymentDirection !== 'forward') continue;
        if (transfer.senderAddress === null) continue;
        const party = identifyParty(
          transfer.senderAddress,
          swap.resolved_party_a_address,
          swap.resolved_party_b_address,
        );
        if (party !== 'A') {
          try {
            await this._bouncePayment(swap, invoiceId, transfer, 'UNKNOWN_SENDER');
          } catch {
            // Already logged inside _bouncePayment; continue bouncing others
          }
        }
      }
      for (const transfer of assetB.transfers) {
        if (transfer.paymentDirection !== 'forward') continue;
        if (transfer.senderAddress === null) continue;
        const party = identifyParty(
          transfer.senderAddress,
          swap.resolved_party_a_address,
          swap.resolved_party_b_address,
        );
        if (party !== 'B') {
          try {
            await this._bouncePayment(swap, invoiceId, transfer, 'UNKNOWN_SENDER');
          } catch {
            // Already logged inside _bouncePayment; continue bouncing others
          }
        }
      }
      return;
    }

    // 3. Transition to DEPOSIT_COVERED
    const coveredSwap = this.stateStore.updateState(
      swap.swap_id,
      SwapState.DEPOSIT_COVERED,
      {},
      swap.version,
    );

    if (!coveredSwap) {
      logger.warn(
        { swap_id: swap.swap_id },
        'invoice:covered — version mismatch transitioning to DEPOSIT_COVERED, concurrent handler?',
      );
      return;
    }

    // 4. Cancel timeout timer
    this.timeoutManager.cancel(swap.swap_id);

    // 5. Close deposit invoice (no autoReturn)
    try {
      await this.invoiceManager.closeDepositInvoice(invoiceId);
    } catch (err) {
      if (isSphereError(err)) {
        if (err.code === 'INVOICE_ALREADY_CLOSED') {
          // Already closed — proceed to payout creation
          logger.info({ swap_id: swap.swap_id }, 'Deposit invoice already closed, proceeding to payouts');
        } else if (err.code === 'INVOICE_ALREADY_CANCELLED') {
          // Timeout won the race — the invoice is cancelled and deposits are
          // being auto-returned. We cannot proceed with conclusion. The swap is
          // currently in DEPOSIT_COVERED (we transitioned it above). Transition
          // to FAILED for manual reconciliation — crash recovery handles
          // DEPOSIT_COVERED + CANCELLED via _recoverCancelledAfterCoverage.
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
        } else if (err.code === 'INVOICE_ALREADY_CLOSED') {
          // Coverage won the race — the invoice was closed (covered) before
          // cancelInvoice could run.  The swap is stuck in CANCELLING because
          // the invoice:covered event likely already fired (and was rejected
          // because the swap was no longer in a deposit-accepting state).
          // Transition to FAILED so crash recovery can pick this up and
          // resume conclusion.
          logger.warn({ swap_id: swapId }, 'Invoice already closed (coverage won race) — transitioning to FAILED for crash recovery');
          await this._transitionToFailed(cancelling, 'Timeout/coverage race: invoice closed before cancellation');
          return;
        }
      }
      logger.error({ err, swap_id: swapId }, 'Failed to cancel invoice on timeout');
      await this._transitionToFailed(cancelling, `Cancel invoice failed: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: conclusion
  // ---------------------------------------------------------------------------

  /**
   * Executes the conclusion phase for a covered swap.
   *
   * This method handles steps 6-9 of the invoice:covered handler:
   * 6. Create payout invoices A and B
   * 7. Persist as CONCLUDING with payout IDs BEFORE paying
   * 8. Pay both payout invoices
   * 9. Send payment_confirmation DMs
   * 10. Transition to COMPLETED
   */
  async _concludeSwap(swap: SwapRecord): Promise<void> {
    const manifest = swap.manifest;

    // Create payout invoice A: party A receives party B's currency
    const payoutAResult = await this.invoiceManager.createPayoutInvoice(
      manifest.swap_id,
      swap.resolved_party_a_address,
      manifest.party_b_currency_to_change,
      manifest.party_b_value_to_change,
      'A',
    );

    if (!payoutAResult.success || !payoutAResult.invoiceId) {
      const errMsg = payoutAResult.error ?? 'Unknown payout A invoice creation error';
      logger.error({ swap_id: swap.swap_id, error: errMsg }, 'Failed to create payout A invoice');
      await this._transitionToFailed(swap, `Payout A invoice creation failed: ${errMsg}`);
      return;
    }

    // Create payout invoice B: party B receives party A's currency
    const payoutBResult = await this.invoiceManager.createPayoutInvoice(
      manifest.swap_id,
      swap.resolved_party_b_address,
      manifest.party_a_currency_to_change,
      manifest.party_a_value_to_change,
      'B',
    );

    if (!payoutBResult.success || !payoutBResult.invoiceId) {
      const errMsg = payoutBResult.error ?? 'Unknown payout B invoice creation error';
      logger.error({ swap_id: swap.swap_id, error: errMsg }, 'Failed to create payout B invoice');
      await this._transitionToFailed(swap, `Payout B invoice creation failed: ${errMsg}`);
      return;
    }

    const payoutAId = payoutAResult.invoiceId;
    const payoutBId = payoutBResult.invoiceId;

    // PERSIST AS CONCLUDING WITH BOTH PAYOUT IDs BEFORE PAYING
    // This is the crash recovery checkpoint — if we crash between here and
    // COMPLETED, recovery will find CONCLUDING state and re-pay.
    const currentSwap = this.stateStore.findBySwapId(swap.swap_id);
    if (!currentSwap) {
      logger.error({ swap_id: swap.swap_id }, 'Swap not found when transitioning to CONCLUDING');
      return;
    }

    let concluding = this.stateStore.updateState(
      swap.swap_id,
      SwapState.CONCLUDING,
      {
        payout_a_invoice_id: payoutAId,
        payout_b_invoice_id: payoutBId,
      },
      currentSwap.version,
    );

    if (!concluding) {
      // Version mismatch — another path may have already moved the swap forward.
      // Check if we're already CONCLUDING (another handler won the race).
      const recheck = this.stateStore.findBySwapId(swap.swap_id);
      if (recheck?.state === SwapState.CONCLUDING) {
        logger.info({ swap_id: swap.swap_id }, 'Another handler already transitioned to CONCLUDING');
        concluding = recheck;
      } else {
        logger.error(
          { swap_id: swap.swap_id, currentState: recheck?.state },
          'Version mismatch persisting CONCLUDING — swap in unexpected state, orphaned payout invoices',
        );
        if (recheck) {
          await this._transitionToFailed(recheck, `CONCLUDING version mismatch; payout invoices ${payoutAId}, ${payoutBId} may be orphaned`);
        }
        return;
      }
    }

    logger.info(
      { swap_id: swap.swap_id, payoutAId, payoutBId },
      'Swap concluding — paying payout invoices',
    );

    // Pay payout A: targetIndex 0, assetIndex 0
    try {
      await this.invoiceManager.payInvoice(payoutAId, {
        targetIndex: 0,
        assetIndex: 0,
        amount: manifest.party_b_value_to_change,
      });
    } catch (err) {
      if (isSphereError(err) && (err.code === 'INVOICE_TERMINATED' || err.code === 'INVOICE_INVALID_AMOUNT')) {
        logger.info({ swap_id: swap.swap_id, payoutAId }, 'Payout A already covered (idempotent)');
      } else {
        logger.error({ err, swap_id: swap.swap_id, payoutAId }, 'Failed to pay payout A invoice');
        await this._transitionToFailed(concluding, `Payout A payment failed: ${String(err)}`);
        return;
      }
    }

    // Pay payout B: targetIndex 0, assetIndex 0
    try {
      await this.invoiceManager.payInvoice(payoutBId, {
        targetIndex: 0,
        assetIndex: 0,
        amount: manifest.party_a_value_to_change,
      });
    } catch (err) {
      if (isSphereError(err) && (err.code === 'INVOICE_TERMINATED' || err.code === 'INVOICE_INVALID_AMOUNT')) {
        logger.info({ swap_id: swap.swap_id, payoutBId }, 'Payout B already covered (idempotent)');
      } else {
        logger.error({ err, swap_id: swap.swap_id, payoutBId }, 'Failed to pay payout B invoice');
        await this._transitionToFailed(concluding, `Payout B payment failed: ${String(err)}`);
        return;
      }
    }

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
      logger.info({ swap_id: swap.swap_id }, 'Swap completed successfully');
    } else {
      logger.warn({ swap_id: swap.swap_id }, 'Version mismatch transitioning to COMPLETED (likely already completed)');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------------

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
    reason: 'UNKNOWN_SENDER' | 'WRONG_CURRENCY' | 'ALREADY_COVERED',
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
      logger.error(
        { err, swap_id: swap.swap_id, transferId: transfer.transferId, reason },
        'Failed to return payment (bounce) — funds may be trapped in deposit invoice',
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
  private async _transitionToFailed(swap: SwapRecord, errorMessage: string): Promise<void> {
    const failed = this.stateStore.updateState(
      swap.swap_id,
      SwapState.FAILED,
      { error_message: errorMessage },
      swap.version,
    );

    if (failed) {
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
