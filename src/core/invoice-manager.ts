/**
 * InvoiceManager
 *
 * Thin wrapper around the AccountingModule that exposes swap-specific invoice
 * operations. All invoice lifecycle, balance tracking, and payment attribution
 * is delegated to the AccountingModule.
 */

import type { TransferResult } from '@unicitylabs/sphere-sdk';
import type {
  IAccountingModule as AccountingModule,
  CreateInvoiceResult,
  InvoiceStatus,
  PayInvoiceParams,
  ReturnPaymentParams,
} from './accounting-types.js';
import type { SwapManifest } from './manifest-validator.js';

/** Minimal event emitter interface satisfied by Sphere.on()/off(). */
export interface EventSource {
  // eslint-disable-next-line @typescript-eslint/ban-types
  on(event: string, handler: Function): (() => void) | void;
  // eslint-disable-next-line @typescript-eslint/ban-types
  off(event: string, handler: Function): void;
}

export interface InvoiceManagerDeps {
  /** AccountingModule from @unicitylabs/sphere-sdk (duck-typed as AccountingModule interface). */
  accounting: AccountingModule;
  /** Escrow's own DIRECT:// address — used as the deposit invoice target. */
  escrowAddress: string;
  /** Event source for invoice events (typically the Sphere instance). */
  eventSource?: EventSource;
}

/**
 * InvoiceManager wraps the AccountingModule for swap-specific operations.
 *
 * It provides named methods that map to accounting operations while encoding
 * the correct parameters (memo format, autoReturn semantics, etc.) per the
 * architecture spec.
 */
export class InvoiceManager {
  private readonly accounting: AccountingModule;
  private readonly escrowAddress: string;
  private readonly eventSource: EventSource;

  constructor(deps: InvoiceManagerDeps) {
    this.accounting = deps.accounting;
    this.escrowAddress = deps.escrowAddress;
    // Use explicit eventSource if provided; fall back to accounting (works for mocks with on/off).
    this.eventSource = deps.eventSource ?? (deps.accounting as unknown as EventSource);
  }

  /**
   * Creates the deposit invoice for a swap.
   *
   * The invoice targets the escrow's own DIRECT address and requests two coin
   * assets — one per party. Both parties pay into this single invoice.
   *
   * @param manifest - The validated swap manifest.
   * @returns The invoice creation result, including the invoiceId token.
   */
  async createDepositInvoice(manifest: SwapManifest): Promise<CreateInvoiceResult> {
    return this.accounting.createInvoice({
      targets: [
        {
          address: this.escrowAddress,
          assets: [
            { coin: [manifest.party_a_currency_to_change, manifest.party_a_value_to_change] },
            { coin: [manifest.party_b_currency_to_change, manifest.party_b_value_to_change] },
          ],
        },
      ],
      memo: `Escrow deposit for swap ${manifest.swap_id}`,
      dueDate: Date.now() + manifest.timeout * 1000,
    });
  }

  /**
   * Creates a payout invoice targeting one party's DIRECT address.
   *
   * Payout invoices have a single target and single coin asset — the
   * counter-currency the receiving party should receive.
   *
   * @param swapId - The swap identifier (embedded in memo).
   * @param targetAddress - The receiving party's resolved DIRECT:// address.
   * @param coinId - The coin ID the party will receive.
   * @param amount - The amount (smallest units) the party will receive.
   * @param partyLabel - 'A' or 'B' label used in the memo.
   * @returns The invoice creation result.
   */
  async createPayoutInvoice(
    swapId: string,
    targetAddress: string,
    coinId: string,
    amount: string,
    partyLabel: 'A' | 'B',
  ): Promise<CreateInvoiceResult> {
    return this.accounting.createInvoice({
      targets: [
        {
          address: targetAddress,
          assets: [{ coin: [coinId, amount] }],
        },
      ],
      memo: `Swap ${swapId} payout to Party ${partyLabel}`,
    });
  }

  /**
   * Closes the deposit invoice WITHOUT autoReturn.
   *
   * Per architecture.md §Event-Driven Flow: do NOT pass autoReturn here.
   * Surplus handling is done after payouts complete; concurrent autoReturn
   * and payInvoice calls create a race for the escrow's token balance.
   *
   * @param invoiceId - The deposit invoice ID to close.
   */
  async closeDepositInvoice(invoiceId: string): Promise<void> {
    await this.accounting.closeInvoice(invoiceId);
  }

  /**
   * Cancels the deposit invoice WITH autoReturn: true.
   *
   * Used on timeout — the AccountingModule handles returning all deposited
   * funds to their original senders via the auto-return dedup ledger.
   *
   * @param invoiceId - The deposit invoice ID to cancel.
   */
  async cancelDepositInvoice(invoiceId: string): Promise<void> {
    await this.accounting.cancelInvoice(invoiceId, { autoReturn: true });
  }

  /**
   * Pays into an invoice (used for payout invoices).
   *
   * Delegates directly to accounting.payInvoice. During crash recovery,
   * callers must omit the `amount` parameter so the SDK computes the
   * remaining amount and throws INVOICE_INVALID_AMOUNT if already covered.
   *
   * @param invoiceId - The target invoice ID.
   * @param params - Payment parameters (targetIndex, assetIndex, optional amount).
   * @returns TransferResult from the SDK.
   */
  async payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult> {
    return this.accounting.payInvoice(invoiceId, params);
  }

  /**
   * Returns an unauthorized or incorrect payment back to its sender.
   *
   * The recipient must be the effectiveSender (refundAddress ?? senderAddress),
   * NOT the raw senderAddress, because the SDK validates the balance cap against
   * senderBalances which are keyed by effectiveSender.
   *
   * @param invoiceId - The deposit invoice ID the payment was made to.
   * @param params - Return parameters (recipient, amount, coinId, optional freeText).
   * @returns TransferResult from the SDK.
   */
  async returnPayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult> {
    return this.accounting.returnInvoicePayment(invoiceId, params);
  }

  /**
   * Gets the current status of an invoice.
   *
   * For non-terminal invoices: computed fresh from transaction history.
   * For terminal invoices (CLOSED/CANCELLED): returns persisted frozen balances.
   *
   * @param invoiceId - The invoice ID to query.
   * @returns The full InvoiceStatus including per-target breakdown.
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus> {
    return this.accounting.getInvoiceStatus(invoiceId);
  }

  /**
   * Subscribes to an AccountingModule event.
   *
   * Used by SwapOrchestrator to subscribe to invoice lifecycle events
   * (invoice:payment, invoice:covered, invoice:cancelled).
   *
   * @param event - The event name.
   * @param handler - The event handler function.
   */
  // eslint-disable-next-line @typescript-eslint/ban-types
  on(event: string, handler: Function): void {
    this.eventSource.on(event, handler);
  }

  /**
   * Unsubscribes from an AccountingModule event.
   *
   * @param event - The event name.
   * @param handler - The event handler function (must be the same reference used in on()).
   */
  // eslint-disable-next-line @typescript-eslint/ban-types
  off(event: string, handler: Function): void {
    this.eventSource.off(event, handler);
  }
}
