import { SwapState, isTerminalState } from '../../core/state-machine.js';
import type { SwapRecord, SwapStateStore, ResolvedAddresses } from '../../core/types.js';
import type { SwapManifest } from '../../core/manifest-validator.js';

/**
 * In-memory implementation of SwapStateStore for testing.
 * Supports optimistic locking via version field.
 */
export class InMemorySwapStateStore implements SwapStateStore {
  private swaps = new Map<string, SwapRecord>();
  private invoiceIndex = new Map<string, string>(); // invoiceId → swapId

  /**
   * Creates a new swap record in ANNOUNCED state.
   */
  create(manifest: SwapManifest, resolvedAddresses: ResolvedAddresses): SwapRecord {
    // Idempotency guard: return existing record without overwriting
    const existing = this.swaps.get(manifest.swap_id);
    if (existing !== undefined) {
      return this.clone(existing);
    }

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
   * Finds a swap by swap_id.
   */
  findBySwapId(swapId: string): SwapRecord | null {
    const record = this.swaps.get(swapId);
    return record ? this.clone(record) : null;
  }

  /**
   * Finds a swap by invoice ID (reverse lookup).
   * Searches across deposit_invoice_id, payout_a_invoice_id, and payout_b_invoice_id.
   */
  findByInvoiceId(invoiceId: string): SwapRecord | null {
    const swapId = this.invoiceIndex.get(invoiceId);
    if (!swapId) return null;
    const record = this.swaps.get(swapId);
    return record ? this.clone(record) : null;
  }

  /**
   * Finds all non-terminal swaps.
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
   * Updates swap state with optimistic locking.
   * Returns null if version mismatch.
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

    // Note: isValidTransition is NOT enforced here — tests deliberately force
    // invalid transitions to simulate crash-recovery states (e.g., COMPLETED → CONCLUDING).
    // The production SwapStateStore enforces transition validation.

    // Update state and increment version
    record.state = newState;
    record.version++;

    // Apply updates — only allow safe mutable fields
    const ALLOWED_UPDATE_FIELDS = new Set([
      'deposit_invoice_id',
      'payout_a_invoice_id',
      'payout_b_invoice_id',
      'first_deposit_at',
      'timeout_at',
      'completed_at',
      'error_message',
    ]);

    // Apply other updates
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && key !== 'state' && key !== 'version') {
        if (!ALLOWED_UPDATE_FIELDS.has(key)) {
          throw new Error(`updateState: field '${key}' is not in the allowed update list (swap ${swapId})`);
        }
        (record as any)[key] = value;
      }
    }

    // Update invoice index if invoice IDs changed
    this.updateInvoiceIndex(swapId, record);

    return this.clone(record);
  }

  /**
   * Updates the invoice index whenever invoice IDs change.
   */
  private updateInvoiceIndex(swapId: string, record: SwapRecord): void {
    // Clear old mappings for this swap
    for (const [invoiceId, id] of this.invoiceIndex.entries()) {
      if (id === swapId) {
        this.invoiceIndex.delete(invoiceId);
      }
    }

    // Add new mappings
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
   * Clones a record to ensure immutability from the caller's perspective.
   */
  private clone(record: SwapRecord): SwapRecord {
    return {
      ...record,
      manifest: { ...record.manifest },
    };
  }
}
