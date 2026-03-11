/**
 * Local type definitions for AccountingModule operations.
 *
 * The sphere-sdk AccountingModule types are not exported via the package's
 * public exports map. These types mirror the relevant subset of
 * @unicitylabs/sphere-sdk/modules/accounting/types.ts for use in production code.
 *
 * These definitions must be kept in sync with the SDK types they shadow.
 */

import type { TransferResult } from '@unicitylabs/sphere-sdk';

// =============================================================================
// Shared asset types
// =============================================================================

/** A fungible coin entry — [coinId, amount in smallest units]. */
export type CoinEntry = [string, string];

/** An asset specification in an invoice target. */
export interface InvoiceRequestedAsset {
  coin?: CoinEntry;
}

/** A target in an invoice (address + assets requested). */
export interface InvoiceTarget {
  address: string;
  assets: InvoiceRequestedAsset[];
}

/** Invoice terms as specified when creating an invoice. */
export interface InvoiceTerms {
  targets?: InvoiceTarget[];
  createdAt?: number;
  dueDate?: number;
  memo?: string;
  deliveryMethods?: string[];
  anonymous?: boolean;
}

/** Parameters for createInvoice(). */
export interface CreateInvoiceRequest {
  targets: InvoiceTarget[];
  createdAt?: number;
  dueDate?: number;
  memo?: string;
  deliveryMethods?: string[];
  anonymous?: boolean;
}

/** Result of invoice creation. */
export interface CreateInvoiceResult {
  readonly success: boolean;
  readonly invoiceId?: string;
  readonly token?: unknown;
  readonly terms?: InvoiceTerms;
  readonly error?: string;
}

// =============================================================================
// Invoice state
// =============================================================================

/** Computed state of an invoice. */
export type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

// =============================================================================
// Transfer reference
// =============================================================================

/**
 * Reference to a transfer that contributes to an invoice.
 *
 * The senderAddress is derived from the on-chain cryptographic signature —
 * it cannot be forged. Null for masked-predicate senders (owner hidden on-chain).
 *
 * The refundAddress is self-asserted by the sender (from inv.ra in the message).
 * Do NOT use it for identity verification — use senderAddress only.
 */
export interface InvoiceTransferRef {
  readonly transferId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  readonly coinId: string;
  readonly amount: string;
  readonly destinationAddress: string;
  readonly timestamp: number;
  readonly confirmed: boolean;
  /** Cryptographically-authenticated sender address. Null for masked predicates. */
  readonly senderAddress: string | null;
  /** Self-asserted refund address (inv.ra). Use for return routing only, not identity. */
  readonly refundAddress?: string;
  readonly contact?: { address: string; url?: string };
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly recipientPubkey?: string;
  readonly recipientNametag?: string;
}

// =============================================================================
// Sender balance tracking
// =============================================================================

/** Per-sender balance summary within an invoice (keyed by effectiveSender). */
export interface InvoiceSenderBalance {
  readonly senderAddress: string;
  readonly netBalance: string;
}

// =============================================================================
// Invoice status
// =============================================================================

/** Per-coin-asset balance summary within an invoice target. */
export interface InvoiceCoinAssetStatus {
  readonly coin: CoinEntry;
  readonly coveredAmount: string;
  readonly returnedAmount: string;
  readonly netCoveredAmount: string;
  readonly isCovered: boolean;
  readonly surplusAmount: string;
  readonly confirmed: boolean;
  readonly transfers: InvoiceTransferRef[];
  readonly senderBalances: InvoiceSenderBalance[];
}

/** Per-target status within an invoice. */
export interface InvoiceTargetStatus {
  readonly address: string;
  readonly coinAssets: InvoiceCoinAssetStatus[];
  readonly nftAssets: unknown[];
  readonly isCovered: boolean;
  readonly confirmed: boolean;
}

/** Complete computed status of an invoice. */
export interface InvoiceStatus {
  readonly invoiceId: string;
  readonly state: InvoiceState;
  readonly targets: InvoiceTargetStatus[];
  readonly irrelevantTransfers: InvoiceTransferRef[];
  readonly totalForward: Record<string, string>;
  readonly totalBack: Record<string, string>;
  readonly allConfirmed: boolean;
  readonly lastActivityAt: number;
  readonly explicitClose?: boolean;
}

// =============================================================================
// Payment parameters
// =============================================================================

/** Parameters for payInvoice(). */
export interface PayInvoiceParams {
  readonly targetIndex: number;
  readonly assetIndex?: number;
  /** Omit to let SDK compute remaining (required for crash recovery retry safety). */
  readonly amount?: string;
  readonly freeText?: string;
  readonly refundAddress?: string;
  readonly contact?: { address: string; url?: string };
}

/** Parameters for returnInvoicePayment(). */
export interface ReturnPaymentParams {
  readonly recipient: string;
  readonly amount: string;
  readonly coinId: string;
  readonly freeText?: string;
}

// =============================================================================
// Error handling utilities
// =============================================================================

/**
 * SphereErrorCode subset — only the codes used by the escrow service.
 *
 * The SphereError class and isSphereError helper are not publicly exported
 * from @unicitylabs/sphere-sdk's compiled dist. We implement a local duck-typed
 * check instead.
 */
export type SphereErrorCode =
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_ALREADY_EXISTS'
  | 'INVOICE_ALREADY_CLOSED'
  | 'INVOICE_ALREADY_CANCELLED'
  | 'INVOICE_INVALID_AMOUNT'
  | 'INVOICE_TERMINATED'
  | string; // allow other codes through

/** Minimal shape of a SphereError for duck-typing. */
interface SphereErrorLike {
  code: SphereErrorCode;
  message: string;
}

/**
 * Returns true if err is a SphereError-like object with a `code` property.
 *
 * Used to avoid importing the SphereError class from the unexported SDK subpath.
 */
export function isSphereError(err: unknown): err is SphereErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  );
}

// =============================================================================
// AccountingModule interface (duck-typed for production use)
// =============================================================================

/**
 * Duck-typed interface for the AccountingModule operations used by the escrow.
 *
 * This allows the escrow to use the real AccountingModule (from @unicitylabs/sphere-sdk)
 * or any compatible mock without importing from the unexported sub-path.
 */
export interface IAccountingModule {
  createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult>;
  getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus>;
  closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;
  cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>;
  payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult>;
  returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult>;
  importInvoice(token: unknown): Promise<InvoiceTerms>;
  // eslint-disable-next-line @typescript-eslint/ban-types
  on(event: string, handler: Function): void;
  // eslint-disable-next-line @typescript-eslint/ban-types
  off(event: string, handler: Function): void;
}
