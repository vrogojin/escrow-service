/**
 * SwapStateStore — Production In-Memory Implementation
 *
 * Production implementation of the SwapStateStore interface. This is an
 * in-memory store suitable for single-instance deployments (per architecture.md
 * §Deployment Constraint: Single-Instance).
 *
 * For production use with persistence across restarts, this implementation
 * should be replaced or wrapped with a durable storage backend. The interface
 * contract remains identical.
 *
 * Supports optimistic locking via the version field on each SwapRecord.
 */

import { SwapState, isTerminalState, isValidTransition } from './state-machine.js';
import type { SwapRecord, SwapStateStore, ResolvedAddresses } from './types.js';
import type { SwapManifest } from './manifest-validator.js';

/**
 * Production in-memory implementation of SwapStateStore.
 *
 * Thread-safety: Node.js's single-threaded event loop means concurrent
 * access within a single process is safe without explicit locking, as long
 * as no await boundaries are crossed between a read and its dependent write.
 * The orchestrator must ensure it reads and writes atomically (no awaits
 * between findBySwapId and updateState when version-dependent).
 */
export class InMemorySwapStateStore implements SwapStateStore {
  private readonly swaps = new Map<string, SwapRecord>();
  /** Reverse index: invoiceId → swapId for fast lookup by invoice. */
  private readonly invoiceIndex = new Map<string, string>();

  /**
   * Creates a new swap record in ANNOUNCED state.
   *
   * The record is created with version 1. Resolved DIRECT:// addresses are
   * cached to prevent nametag reassignment mid-swap from causing misidentification.
   *
   * @param manifest - The validated swap manifest.
   * @param resolvedAddresses - Pre-resolved DIRECT:// addresses for both parties.
   * @returns The newly created SwapRecord (a clone, not the internal reference).
   */
  create(manifest: SwapManifest, resolvedAddresses: ResolvedAddresses): SwapRecord {
    const record: SwapRecord = {
      swap_id: manifest.swap_id,
      manifest,
      state: SwapState.ANNOUNCED,
      deposit_invoice_id: null,
      payout_a_invoice_id: null,
      payout_b_invoice_id: null,
      resolved_party_a_address: resolvedAddresses.partyA,
      resolved_party_b_address: resolvedAddresses.partyB,
      first_deposit_at: null,
      timeout_at: null,
      created_at: Date.now(),
      completed_at: null,
      error_message: null,
      version: 1,
    };

    this.swaps.set(manifest.swap_id, record);
    return this.clone(record);
  }

  /**
   * Finds a swap record by its swap_id.
   *
   * @param swapId - The 64-hex-char swap identifier.
   * @returns A clone of the record, or null if not found.
   */
  findBySwapId(swapId: string): SwapRecord | null {
    const record = this.swaps.get(swapId);
    return record ? this.clone(record) : null;
  }

  /**
   * Finds a swap record by any of its invoice IDs.
   *
   * Searches across deposit_invoice_id, payout_a_invoice_id, and payout_b_invoice_id
   * via the invoice reverse index.
   *
   * @param invoiceId - The invoice token ID (64-hex chars).
   * @returns A clone of the record, or null if not found.
   */
  findByInvoiceId(invoiceId: string): SwapRecord | null {
    const swapId = this.invoiceIndex.get(invoiceId);
    if (!swapId) return null;
    const record = this.swaps.get(swapId);
    return record ? this.clone(record) : null;
  }

  /**
   * Returns all non-terminal swap records (for crash recovery).
   *
   * Terminal states (COMPLETED, CANCELLED, FAILED) are excluded.
   *
   * @returns Array of cloned non-terminal SwapRecord objects.
   */
  findNonTerminal(): SwapRecord[] {
    const results: SwapRecord[] = [];
    for (const record of this.swaps.values()) {
      if (!isTerminalState(record.state)) {
        results.push(this.clone(record));
      }
    }
    return results;
  }

  /**
   * Updates the swap state with optimistic locking.
   *
   * Returns null if the expectedVersion does not match the stored version,
   * indicating a concurrent modification. Callers must handle null returns
   * by reloading and retrying or aborting.
   *
   * Invoice IDs in the updates are automatically indexed for reverse lookup.
   *
   * @param swapId - The swap identifier.
   * @param newState - The new SwapState to transition to.
   * @param updates - Additional SwapRecord fields to update (state and version are managed internally).
   * @param expectedVersion - The version the caller read. Must match current version.
   * @returns The updated SwapRecord (clone), or null on version mismatch.
   */
  updateState(
    swapId: string,
    newState: SwapState,
    updates: Partial<SwapRecord>,
    expectedVersion: number,
  ): SwapRecord | null {
    const record = this.swaps.get(swapId);
    if (!record || record.version !== expectedVersion) {
      return null;
    }

    if (!isValidTransition(record.state, newState)) {
      throw new Error(`Invalid state transition: ${record.state} → ${newState} (swap ${swapId})`);
    }

    record.state = newState;
    record.version++;

    // Apply updates (skip state and version — managed above)
    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'state' && key !== 'version' && value !== undefined) {
        (record as unknown as Record<string, unknown>)[key] = value;
      }
    }

    this.rebuildInvoiceIndex(swapId, record);

    return this.clone(record);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Rebuilds the invoice reverse index for a single swap record.
   * Clears old mappings for the swap before adding new ones.
   */
  private rebuildInvoiceIndex(swapId: string, record: SwapRecord): void {
    // Remove all existing entries for this swap
    for (const [invoiceId, id] of this.invoiceIndex.entries()) {
      if (id === swapId) {
        this.invoiceIndex.delete(invoiceId);
      }
    }

    // Add current invoice IDs
    if (record.deposit_invoice_id) {
      this.invoiceIndex.set(record.deposit_invoice_id, swapId);
    }
    if (record.payout_a_invoice_id) {
      this.invoiceIndex.set(record.payout_a_invoice_id, swapId);
    }
    if (record.payout_b_invoice_id) {
      this.invoiceIndex.set(record.payout_b_invoice_id, swapId);
    }
  }

  /**
   * Returns a deep-enough clone of a SwapRecord to prevent external mutation
   * of the stored reference. The manifest object is also cloned.
   */
  private clone(record: SwapRecord): SwapRecord {
    return {
      ...record,
      manifest: { ...record.manifest },
    };
  }
}
