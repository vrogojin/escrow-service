import type { SwapState } from './state-machine.js';

/**
 * The full swap manifest — the agreement between two parties.
 * Re-exported from manifest-validator.ts for convenience.
 */
export type { SwapManifest } from './manifest-validator.js';

/**
 * Resolved DIRECT:// addresses for both parties.
 */
export interface ResolvedAddresses {
  partyA: string; // DIRECT://...
  partyB: string; // DIRECT://...
}

/**
 * The persistent swap record stored in SwapStateStore.
 */
export interface SwapRecord {
  swap_id: string;
  manifest: import('./manifest-validator.js').SwapManifest;
  state: SwapState;
  deposit_invoice_id: string | null;
  payout_a_invoice_id: string | null;
  payout_b_invoice_id: string | null;
  resolved_party_a_address: string; // cached DIRECT:// address
  resolved_party_b_address: string; // cached DIRECT:// address
  first_deposit_at: number | null; // epoch ms
  timeout_at: number | null; // epoch ms
  created_at: number; // epoch ms
  completed_at: number | null; // epoch ms
  error_message: string | null;
  version: number; // optimistic concurrency
}

/**
 * Interface for the swap state persistence layer.
 */
export interface SwapStateStore {
  create(
    manifest: import('./manifest-validator.js').SwapManifest,
    resolvedAddresses: ResolvedAddresses,
  ): SwapRecord;
  findBySwapId(swapId: string): SwapRecord | null;
  findByInvoiceId(invoiceId: string): SwapRecord | null;
  findNonTerminal(): SwapRecord[];
  updateState(
    swapId: string,
    newState: SwapState,
    updates: Partial<SwapRecord>,
    expectedVersion: number,
  ): SwapRecord | null;
}

/**
 * Result of deposit validation — which party side the deposit contributes to.
 * Party side is determined by coinId (currency type), not sender address.
 */
export interface DepositValidationResult {
  partySide: 'A' | 'B' | null; // null = invalid/rejected deposit
  effectiveSender: string | null; // refundAddress ?? senderAddress (for return routing)
  coinId: string;
  amount: string;
  transferId: string;
  reason?: 'WRONG_CURRENCY' | 'MASKED_NO_REFUND';
}

/**
 * Result of a swap announcement.
 */
export interface AnnounceResult {
  swap_id: string;
  deposit_invoice_id: string;
  is_new: boolean;
}
