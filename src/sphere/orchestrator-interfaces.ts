/**
 * Interfaces for the invoice-based swap orchestration layer.
 * These are consumed by the MessageHandler and may be implemented
 * by SwapOrchestrator, InvoiceManager, and related classes.
 */

import type { SwapRecord } from '../core/types.js';

// ---------------------------------------------------------------------------
// SwapOrchestrator
// ---------------------------------------------------------------------------

/**
 * Result returned when a manifest is announced to the orchestrator.
 */
export interface AnnounceResult {
  /** Content-addressed swap identifier (64 hex chars). */
  swap_id: string;
  /** Invoice token ID for the deposit invoice (64 hex chars). */
  deposit_invoice_id: string;
  /** True when the swap case was newly created; false when it already existed. */
  is_new: boolean;
}

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
 * Security note: this mapping is trust-based, not cryptographic.  It must
 * always be combined with a DIRECT-address back-check before granting access
 * to sensitive operations.
 */
export interface NpubRoleMap {
  /**
   * Record that `npub` is associated with the given `party` role for `swapId`.
   * Calling this more than once with the same (npub, swapId, party) tuple is
   * idempotent.
   */
  register(npub: string, swapId: string, party: 'A' | 'B'): void;

  /**
   * Return the role that `npub` holds for `swapId`, or `null` when no
   * association has been registered.
   */
  getRole(npub: string, swapId: string): 'A' | 'B' | null;

  /**
   * Return all swap IDs for which `npub` has a registered role.
   */
  getSwapIds(npub: string): string[];
}

// ---------------------------------------------------------------------------
// Error classes (shared between orchestrator and message handler)
// ---------------------------------------------------------------------------

export class ManifestValidationError extends Error {
  constructor(public readonly errors: Array<{ field: string; message: string }>) {
    super(`Manifest validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join(', ')}`);
    this.name = 'ManifestValidationError';
  }
}

export class SwapLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapLimitError';
  }
}
