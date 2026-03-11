import { vi } from 'vitest';
import { createHash } from 'crypto';
import canonicalize from 'canonicalize';
import { SphereError } from '@unicitylabs/sphere-sdk';
import type { TransferResult } from '@unicitylabs/sphere-sdk';

// Invoice accounting types — re-defined locally since sphere-sdk doesn't export them
// These match the SDK's types.ts definitions
export interface CreateInvoiceRequest {
  readonly targets: Array<{
    address: string;
    assets?: Array<[string, string]>;
    nftAssets?: Array<{ tokenId: string; tokenType?: string }>;
  }>;
  readonly dueDate?: number;
  readonly memo?: string;
  readonly deliveryMethods?: string[];
  readonly anonymous?: boolean;
}

export interface InvoiceTerms {
  readonly targets: Array<{
    address: string;
    assets?: Array<[string, string]>;
    nftAssets?: Array<{ tokenId: string; tokenType?: string }>;
  }>;
  readonly dueDate?: number;
  readonly memo?: string;
  readonly deliveryMethods?: string[];
  readonly anonymous?: boolean;
  readonly creator?: string;
}

export interface CreateInvoiceResult {
  readonly success: boolean;
  readonly invoiceId?: string;
  readonly token?: any;
  readonly terms?: InvoiceTerms;
  readonly error?: string;
}

export interface InvoiceTransferRef {
  readonly transferId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  readonly coinId: string;
  readonly amount: string;
  readonly destinationAddress: string;
  readonly timestamp: number;
  readonly confirmed: boolean;
  readonly senderAddress: string | null;
  readonly refundAddress?: string;
  readonly contact?: { address: string; url?: string };
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly recipientPubkey?: string;
  readonly recipientNametag?: string;
}

export interface InvoiceSenderBalance {
  readonly senderAddress: string;
  readonly isRefundAddress?: boolean;
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly contacts: ReadonlyArray<{ address: string; url?: string }>;
  readonly forwardedAmount: string;
  readonly returnedAmount: string;
  readonly netBalance: string;
}

export interface InvoiceStatus {
  readonly invoiceId: string;
  readonly state: 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';
  readonly targets: Array<{
    address: string;
    coinAssets: Array<{
      coin: [string, string];
      coveredAmount: string;
      returnedAmount: string;
      netCoveredAmount: string;
      isCovered: boolean;
      surplusAmount: string;
      confirmed: boolean;
      transfers: InvoiceTransferRef[];
      senderBalances: InvoiceSenderBalance[];
    }>;
    nftAssets: Array<{ nft: any; received: boolean; confirmed: boolean }>;
    isCovered: boolean;
    confirmed: boolean;
  }>;
  readonly irrelevantTransfers: Array<InvoiceTransferRef & { reason: string }>;
  readonly totalForward: Record<string, string>;
  readonly totalBack: Record<string, string>;
  readonly allConfirmed: boolean;
  readonly lastActivityAt: number;
  readonly explicitClose?: boolean;
}

export interface PayInvoiceParams {
  readonly targetIndex: number;
  readonly assetIndex?: number;
  readonly amount?: string;
  readonly freeText?: string;
  readonly refundAddress?: string;
  readonly contact?: { address: string; url?: string };
}

export interface ReturnPaymentParams {
  readonly recipient: string;
  readonly amount: string;
  readonly coinId: string;
  readonly freeText?: string;
}

export interface GetInvoicesOptions {
  readonly state?: string | string[];
  readonly createdByMe?: boolean;
  readonly targetingMe?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: 'createdAt' | 'dueDate';
  readonly sortOrder?: 'asc' | 'desc';
}

export interface InvoiceRef {
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  readonly isCreator: boolean;
  readonly cancelled: boolean;
  readonly closed: boolean;
}

export interface IrrelevantTransfer extends InvoiceTransferRef {
  readonly reason: 'unknown_address' | 'unknown_asset' | 'unknown_address_and_asset' | 'self_payment' | 'no_coin_data' | 'unauthorized_return';
}

/**
 * Internal state for a mock invoice.
 */
export interface MockInvoiceState {
  terms: InvoiceTerms;
  state: 'OPEN' | 'PARTIAL' | 'COVERED' | 'EXPIRED' | 'CLOSED' | 'CANCELLED';
  transfers: InvoiceTransferRef[];
  senderBalances: InvoiceSenderBalance[];
  isClosed: boolean;
  isCancelled: boolean;
}

/**
 * Mock implementation of the AccountingModule for unit/integration testing.
 * Simulates invoice lifecycle and payment operations with deterministic invoice ID generation.
 */
export class MockAccountingModule {
  private invoices = new Map<string, MockInvoiceState>();
  private handlers = new Map<string, Set<Function>>();
  private callOrder: string[] = [];
  // Track concurrent createInvoice calls by canonical terms to detect concurrent duplicate creates
  private inFlightCreates = new Map<string, Promise<string>>();

  /**
   * Creates a new invoice with a deterministic ID based on canonical terms.
   * Throws INVOICE_ALREADY_EXISTS only if two concurrent createInvoice calls
   * with identical terms are in flight simultaneously (detected via inFlightCreates set).
   */
  async createInvoice(request: CreateInvoiceRequest & { createdAt?: number }): Promise<CreateInvoiceResult> {
    const terms: InvoiceTerms = {
      targets: request.targets,
      dueDate: request.dueDate,
      memo: request.memo,
      deliveryMethods: request.deliveryMethods,
      anonymous: request.anonymous,
      creator: (request as any).creator, // Optional field from SDK gap #8 shim
    };

    // Add createdAt to terms if provided (SDK gap #8 shim)
    if ((request as any).createdAt !== undefined) {
      (terms as any).createdAt = (request as any).createdAt;
    }

    const canonical = (canonicalize as any)(terms);
    const invoiceId = createHash('sha256').update(canonical).digest('hex');

    // Check if another concurrent createInvoice is in flight with the same terms
    // Use a synchronous set to track in-flight creates (no promises, just a flag)
    if (this.inFlightCreates.has(canonical)) {
      // Another concurrent call is already creating this invoice
      throw new SphereError(
        'Invoice with these terms already exists in this process',
        'INVOICE_ALREADY_EXISTS' as any,
      );
    }

    // Mark this create as in flight (synchronously set a flag)
    this.inFlightCreates.set(canonical, Promise.resolve(invoiceId));

    try {
      const state: MockInvoiceState = {
        terms,
        state: 'OPEN',
        transfers: [],
        senderBalances: [],
        isClosed: false,
        isCancelled: false,
      };

      this.invoices.set(invoiceId, state);
      this.callOrder.push('createInvoice');

      return {
        success: true,
        invoiceId,
        token: {} as any, // Mock token object
        terms,
      };
    } finally {
      // Clean up the in-flight marker immediately after completion
      this.inFlightCreates.delete(canonical);
    }
  }

  /**
   * Returns the current status of an invoice.
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus> {
    this.callOrder.push('getInvoiceStatus');
    const state = this.invoices.get(invoiceId);
    if (!state) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND' as any) as any;
    }

    // Reconstruct InvoiceStatus from mock state
    const targets = (state.terms.targets ?? []) as any[];
    const invoiceTargets = targets.map((target: any, idx: number) => ({
      address: target.address,
      coinAssets: ((target.assets || []) as any[]).map((asset: any) => {
        const [coinId, requestedAmount] = asset.coin || asset;
        const relevantTransfers = state.transfers.filter(
          (t) =>
            t.paymentDirection === 'forward' &&
            t.coinId === coinId,
        );
        const coveredAmount = relevantTransfers.reduce(
          (sum, t) => String(BigInt(sum) + BigInt(t.amount)),
          '0',
        );
        return {
          coin: asset,
          coveredAmount,
          returnedAmount: '0',
          netCoveredAmount: coveredAmount,
          isCovered: BigInt(coveredAmount) >= BigInt(requestedAmount),
          surplusAmount: '0',
          confirmed: true,
          transfers: relevantTransfers,
          senderBalances: state.senderBalances.filter(
            (sb) => sb.senderAddress, // Filter by relevance if needed
          ),
        };
      }),
      nftAssets: [],
      isCovered: ((target.assets || []) as any[]).every((asset: any) => {
        const [coinId, requestedAmount] = asset.coin || asset;
        const relevantTransfers = state.transfers.filter(
          (t) =>
            t.paymentDirection === 'forward' &&
            t.coinId === coinId,
        );
        const coveredAmount = relevantTransfers.reduce(
          (sum, t) => String(BigInt(sum) + BigInt(t.amount)),
          '0',
        );
        return BigInt(coveredAmount) >= BigInt(requestedAmount);
      }),
      confirmed: true,
    }));

    return {
      invoiceId,
      state: state.state as any,
      targets: invoiceTargets,
      irrelevantTransfers: [],
      totalForward: {},
      totalBack: {},
      allConfirmed: true,
      lastActivityAt: Date.now(),
      explicitClose: state.isClosed,
    };
  }

  /**
   * Closes an invoice.
   * Throws if already closed or cancelled.
   */
  async closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void> {
    this.callOrder.push('closeInvoice');
    const state = this.invoices.get(invoiceId);
    if (!state) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND' as any) as any;
    }
    if (state.isClosed) {
      throw new SphereError('Invoice already closed', 'INVOICE_ALREADY_CLOSED' as any);
    }
    if (state.isCancelled) {
      throw new SphereError('Invoice already cancelled', 'INVOICE_ALREADY_CANCELLED' as any);
    }

    state.isClosed = true;
    state.state = 'CLOSED';
  }

  /**
   * Cancels an invoice.
   * Throws if already cancelled or closed.
   */
  async cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void> {
    this.callOrder.push('cancelInvoice');
    const state = this.invoices.get(invoiceId);
    if (!state) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND' as any) as any;
    }
    if (state.isCancelled) {
      throw new SphereError('Invoice already cancelled', 'INVOICE_ALREADY_CANCELLED' as any);
    }
    if (state.isClosed) {
      throw new SphereError('Invoice already closed', 'INVOICE_ALREADY_CLOSED' as any);
    }

    state.isCancelled = true;
    state.state = 'CANCELLED';
  }

  /**
   * Pays an invoice.
   * Throws INVOICE_INVALID_AMOUNT when remaining = 0 and amount is omitted.
   * Throws INVOICE_TERMINATED on terminated invoices.
   */
  async payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult> {
    this.callOrder.push('payInvoice');
    const state = this.invoices.get(invoiceId);
    if (!state) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND' as any) as any;
    }

    // Check if terminated
    if (state.isClosed || state.isCancelled) {
      throw new SphereError('Invoice is terminated', 'INVOICE_TERMINATED' as any);
    }

    // If amount is omitted, check remaining and throw if zero
    if (params.amount === undefined) {
      // Compute remaining from targets
      const target = state.terms.targets?.[params.targetIndex];
      if (target) {
        const assetIndex = params.assetIndex ?? 0;
        const asset = target.assets?.[assetIndex];
        if (asset) {
          const [coinId, requestedAmount] = (asset as any).coin || asset;
          const relevantTransfers = state.transfers.filter(
            (t) =>
              t.paymentDirection === 'forward' &&
              t.coinId === coinId,
          );
          const covered = relevantTransfers.reduce(
            (sum, t) => String(BigInt(sum) + BigInt(t.amount)),
            '0',
          );
          const remaining = String(BigInt(requestedAmount) - BigInt(covered));
          if (BigInt(remaining) <= 0n) {
            throw new SphereError('Invoice invalid amount', 'INVOICE_INVALID_AMOUNT' as any);
          }
        }
      }
    }

    return {
      id: `transfer_${Date.now()}`,
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
  }

  /**
   * Returns a payment to an invoice.
   * Does NOT throw INVOICE_TERMINATED (SDK allows returns to terminated invoices).
   */
  async returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult> {
    this.callOrder.push('returnInvoicePayment');
    const state = this.invoices.get(invoiceId);
    if (!state) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVALID_IDENTITY' as any) as any;
    }

    return {
      id: `transfer_${Date.now()}`,
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
  }

  /**
   * Imports an invoice token.
   */
  async importInvoice(token: any): Promise<InvoiceTerms> {
    this.callOrder.push('importInvoice');
    return {
      targets: [],
    } as InvoiceTerms;
  }

  /**
   * Lists invoices.
   */
  async getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]> {
    this.callOrder.push('getInvoices');
    const result: InvoiceRef[] = [];
    for (const [invoiceId, state] of this.invoices.entries()) {
      result.push({
        invoiceId,
        terms: state.terms,
        isCreator: true,
        cancelled: state.isCancelled,
        closed: state.isClosed,
      });
    }
    return result;
  }

  /**
   * Registers an event handler.
   */
  on(event: string, handler: Function): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /**
   * Unregisters an event handler.
   */
  off(event: string, handler: Function): void {
    this.handlers.get(event)?.delete(handler);
  }

  /**
   * Simulates a payment event (test control method).
   */
  _simulatePayment(invoiceId: string, transfer: InvoiceTransferRef): void {
    const state = this.invoices.get(invoiceId);
    if (!state) return;

    state.transfers.push(transfer);

    // Update or create sender balance
    const effectiveSender = transfer.refundAddress ?? transfer.senderAddress;

    // Only update senderBalance if we have an effective sender
    // (masked predicate with no refund address means no return route)
    if (effectiveSender) {
      const existingIdx = state.senderBalances.findIndex((sb) => sb.senderAddress === effectiveSender);
      if (existingIdx === -1) {
        state.senderBalances.push({
          senderAddress: effectiveSender,
          netBalance: transfer.amount,
          forwardedAmount: transfer.amount,
          returnedAmount: '0',
          contacts: [],
        });
      } else {
        // Create a new balance object since senderBalances are immutable
        const old = state.senderBalances[existingIdx];
        const newForwarded = String(BigInt(old.forwardedAmount) + BigInt(transfer.amount));
        const newNet = String(BigInt(newForwarded) - BigInt(old.returnedAmount));
        state.senderBalances[existingIdx] = {
          ...old,
          forwardedAmount: newForwarded,
          netBalance: newNet,
        };
      }
    }

    // Fire event
    const handlers = this.handlers.get('invoice:payment');
    if (handlers) {
      handlers.forEach((h) =>
        h({
          invoiceId,
          transfer,
          paymentDirection: 'forward',
          confirmed: true,
        }),
      );
    }
  }

  /**
   * Simulates invoice coverage (test control method).
   */
  _simulateCoverage(invoiceId: string): void {
    const state = this.invoices.get(invoiceId);
    if (!state) return;

    state.state = 'COVERED';

    const handlers = this.handlers.get('invoice:covered');
    if (handlers) {
      handlers.forEach((h) =>
        h({
          invoiceId,
          confirmed: true,
        }),
      );
    }
  }

  /**
   * Simulates invoice cancellation (test control method).
   */
  _simulateCancelled(invoiceId: string): void {
    const state = this.invoices.get(invoiceId);
    if (!state) return;

    state.state = 'CANCELLED';
    state.isCancelled = true;

    const handlers = this.handlers.get('invoice:cancelled');
    if (handlers) {
      handlers.forEach((h) =>
        h({
          invoiceId,
        }),
      );
    }
  }

  /**
   * Gets the internal state of a mock invoice (test introspection).
   */
  _getInvoiceState(invoiceId: string): MockInvoiceState | null {
    return this.invoices.get(invoiceId) ?? null;
  }

  /**
   * Sets the internal state of a mock invoice (test control).
   */
  _setInvoiceState(invoiceId: string, updates: Partial<MockInvoiceState>): void {
    let state = this.invoices.get(invoiceId);
    if (!state) {
      state = {
        terms: {} as InvoiceTerms,
        state: 'OPEN',
        transfers: [],
        senderBalances: [],
        isClosed: false,
        isCancelled: false,
      };
      this.invoices.set(invoiceId, state);
    }

    if (updates.terms !== undefined) state.terms = updates.terms;
    if (updates.state !== undefined) state.state = updates.state;
    if (updates.transfers !== undefined) state.transfers = updates.transfers;
    if (updates.senderBalances !== undefined) state.senderBalances = updates.senderBalances;
    if (updates.isClosed !== undefined) state.isClosed = updates.isClosed;
    if (updates.isCancelled !== undefined) state.isCancelled = updates.isCancelled;
  }

  /**
   * Returns the ordered list of method calls (for persist-before-act verification).
   */
  _getCallOrder(): string[] {
    return this.callOrder as unknown as any;
  }

  /**
   * Resets all state.
   */
  _reset(): void {
    this.invoices.clear();
    this.handlers.clear();
    this.callOrder = [];
    this.inFlightCreates.clear();
  }
}
