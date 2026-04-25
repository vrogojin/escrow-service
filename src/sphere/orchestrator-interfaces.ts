/**
 * Interfaces for the invoice-based swap orchestration layer.
 * These are consumed by the MessageHandler and may be implemented
 * by SwapOrchestrator, InvoiceManager, and related classes.
 */

import type { SwapRecord, AnnounceResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// SwapOrchestrator
// ---------------------------------------------------------------------------

export type { AnnounceResult } from '../core/types.js';

/**
 * Central coordinator that drives the swap lifecycle from announcement through
 * payout.  The MessageHandler delegates business logic here.
 */
export interface SwapOrchestrator {
  /**
   * Submit a swap manifest.
   *
   * - If the swap is new: validates the manifest, creates the swap case in
   *   ANNOUNCED state, resolves party addresses, creates the deposit invoice,
   *   and transitions to DEPOSIT_INVOICE_CREATED.
   * - If the swap already exists in ANNOUNCED state (previous createInvoice
   *   failed): re-attempts invoice creation without creating a duplicate case.
   * - If the swap already exists in any later state: returns the existing case
   *   with `is_new: false`.
   *
   * @throws {ManifestValidationError} when the manifest fails validation.
   * @throws {SwapLimitError} when the pending-swap limit is reached.
   * @throws {Error} with message "Invoice creation failed" when the aggregator
   *   is unreachable.  Callers should surface this to the announcing party so
   *   they can retry.
   */
  announce(
    manifest: import('../core/manifest-validator.js').SwapManifest,
    announcerNpub: string,
  ): Promise<AnnounceResult>;

  /**
   * Cancel a swap that has not yet received deposits.
   *
   * Only allowed in ANNOUNCED or DEPOSIT_INVOICE_CREATED states.
   * If a deposit invoice exists, it will be cancelled (triggering auto-return
   * of any payments that arrived in the meantime).
   *
   * @param swapId - The swap to cancel.
   * @param requestingParty - Which party requested the cancellation ('A' or 'B').
   * @returns Result indicating success or failure with reason.
   */
  cancelSwap(swapId: string, requestingParty: 'A' | 'B'): Promise<{ success: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// SwapStateStore — re-exported shape used by the message handler
// ---------------------------------------------------------------------------

export type { SwapRecord } from '../core/types.js';
export type { SwapStateStore } from '../core/types.js';

// ---------------------------------------------------------------------------
// InvoiceManager
// ---------------------------------------------------------------------------

/**
 * Serialised form of an invoice token suitable for delivery via DM.
 * The concrete shape is defined by the sphere-sdk TxfToken type; the
 * message handler treats it as an opaque JSON-serialisable value.
 */
export type InvoiceToken = unknown;

/**
 * Thin wrapper around the AccountingModule that provides escrow-specific
 * invoice operations and token retrieval.
 */
export interface InvoiceManager {
  /**
   * Get the current status of an invoice.
   *
   * @param invoiceId - The invoice token ID to query.
   * @returns The full invoice status including per-target per-asset breakdown.
   * @throws SphereError with code 'INVOICE_NOT_FOUND' if the invoice token is not loaded.
   */
  getInvoiceStatus(invoiceId: string): Promise<import('../core/accounting-types.js').InvoiceStatus>;

  /**
   * Retrieve the serialised invoice token for a deposit invoice.
   * Returns `null` when the invoice is not found in the local store.
   */
  getDepositInvoiceToken(invoiceId: string): Promise<InvoiceToken | null>;

  /**
   * Retrieve the serialised invoice token for a payout invoice.
   * Returns `null` when the invoice is not found or not yet created.
   */
  getPayoutInvoiceToken(invoiceId: string): Promise<InvoiceToken | null>;
}

// ---------------------------------------------------------------------------
// NpubRoleMap
// ---------------------------------------------------------------------------

/**
 * Tracks the association between Nostr npub keys and (swapId, party role)
 * tuples.  The mapping is established during the announce phase and is used
 * for DM-level authorization of status queries and invoice re-delivery.
 *
 * Each entry caches the sender's resolved DIRECT:// address (obtained via
 * sphere.resolve() at announcement time) so that subsequent requests can be
 * back-checked without an additional network call.
 */
export interface NpubRoleMap {
  /**
   * Record that `npub` is associated with the given `party` role for `swapId`.
   * `directAddress` is the resolved DIRECT:// address of the npub, obtained
   * via sphere.resolve() at announcement time, and is used for authorization
   * back-checks on subsequent requests.
   * Calling this more than once with the same (npub, swapId, party) tuple is
   * idempotent.
   */
  register(npub: string, swapId: string, party: 'A' | 'B', directAddress: string): void;

  /**
   * Return the role and cached directAddress that `npub` holds for `swapId`,
   * or `null` when no association has been registered.
   */
  getRole(npub: string, swapId: string): { role: 'A' | 'B'; directAddress: string } | null;

  /**
   * Return all swap IDs for which `npub` has a registered role.
   */
  getSwapIds(npub: string): string[];

  /**
   * Reverse lookup: given (swapId, party), find the registered npub.
   * Returns `null` when no npub has been registered for that party in the swap.
   */
  findNpub(swapId: string, party: 'A' | 'B'): string | null;

  /**
   * Reverse lookup: given a DIRECT:// address, find the registered npub.
   * Used for bounce DM routing when the sender is not a known party.
   * Optional for backward compatibility with test mocks.
   */
  findNpubByAddress?(directAddress: string): string | null;
}

// ---------------------------------------------------------------------------
// Error classes (shared between orchestrator and message handler)
// ---------------------------------------------------------------------------

export class ManifestValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Manifest validation failed: ${errors.join(', ')}`);
    this.name = 'ManifestValidationError';
  }
}

export class SwapLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapLimitError';
  }
}
