/**
 * Deposit Validator
 *
 * Pure functions for validating deposit payments per architecture.md §Deposit Validation.
 *
 * Key security invariant: identity verification ALWAYS uses the cryptographically-
 * authenticated senderAddress (derived from the transfer's on-chain signature).
 * The refundAddress (from inv.ra) is self-asserted by the sender and used ONLY
 * for return routing (effectiveSender), never for identity verification.
 *
 * DIRECT:// address comparisons are CASE-SENSITIVE exact string matches per the
 * SDK convention. Do NOT use normalizeAddress() here.
 */

import type { InvoiceTransferRef } from './accounting-types.js';
import type { SwapManifest } from './manifest-validator.js';
import type { DepositValidationResult } from './types.js';

/**
 * Identifies which party sent the deposit based on their DIRECT:// address.
 *
 * Uses exact case-sensitive string matching against the resolved party addresses.
 * A null senderAddress (masked predicate) always returns null — the identity
 * cannot be established without the cryptographic sender address.
 *
 * Per architecture.md §7 (Address Resolution): DIRECT address comparison is
 * case-sensitive exact string match. Do NOT use normalizeAddress().
 *
 * @param senderAddress - The cryptographically-authenticated sender address, or null for masked predicates.
 * @param resolvedPartyAAddress - Party A's resolved DIRECT:// address (cached at announcement).
 * @param resolvedPartyBAddress - Party B's resolved DIRECT:// address (cached at announcement).
 * @returns 'A', 'B', or null if the sender cannot be identified.
 */
export function identifyParty(
  senderAddress: string | null,
  resolvedPartyAAddress: string,
  resolvedPartyBAddress: string,
): 'A' | 'B' | null {
  if (senderAddress === null) {
    return null;
  }
  // Exact case-sensitive string match — no normalizeAddress()
  if (senderAddress === resolvedPartyAAddress) {
    return 'A';
  }
  if (senderAddress === resolvedPartyBAddress) {
    return 'B';
  }
  return null;
}

/**
 * Validates that a party paid the correct currency for their role.
 *
 * Party A must pay party_a_currency_to_change (asset index 0 in the deposit invoice).
 * Party B must pay party_b_currency_to_change (asset index 1 in the deposit invoice).
 *
 * @param party - The identified party ('A' or 'B').
 * @param coinId - The coinId from the transfer.
 * @param manifest - The swap manifest.
 * @returns true if the currency matches the party's expected contribution.
 */
export function validateCurrency(
  party: 'A' | 'B',
  coinId: string,
  manifest: SwapManifest,
): boolean {
  if (party === 'A') {
    return coinId === manifest.party_a_currency_to_change;
  }
  return coinId === manifest.party_b_currency_to_change;
}

/**
 * Returns the effective sender address for return routing.
 *
 * This is refundAddress ?? senderAddress, following the SDK's senderBalances
 * keying convention (effectiveSender). Both fields can be null/undefined —
 * if both are absent, returns null (cannot route return).
 *
 * IMPORTANT: This is used for return routing ONLY. Identity verification
 * must still use the raw senderAddress (not this function's return value).
 *
 * @param transfer - The invoice transfer reference.
 * @returns The effective sender address for return routing, or null if unavailable.
 */
export function getEffectiveSender(transfer: InvoiceTransferRef): string | null {
  return transfer.refundAddress ?? transfer.senderAddress ?? null;
}

/**
 * Validates a deposit transfer against the swap manifest.
 *
 * Combines identifyParty and validateCurrency into a single result that
 * includes routing information for return payments.
 *
 * @param transfer - The invoice transfer reference from getInvoiceStatus().
 * @param resolvedPartyAAddress - Party A's resolved DIRECT:// address.
 * @param resolvedPartyBAddress - Party B's resolved DIRECT:// address.
 * @param manifest - The swap manifest.
 * @returns DepositValidationResult with party identification and validation reason.
 */
export function validateDeposit(
  transfer: InvoiceTransferRef,
  resolvedPartyAAddress: string,
  resolvedPartyBAddress: string,
  manifest: SwapManifest,
): DepositValidationResult {
  const base: Omit<DepositValidationResult, 'party' | 'reason'> = {
    senderAddress: transfer.senderAddress,
    effectiveSender: getEffectiveSender(transfer),
    coinId: transfer.coinId,
    amount: transfer.amount,
    transferId: transfer.transferId,
  };

  // Masked predicate — cannot verify identity
  if (transfer.senderAddress === null) {
    return {
      ...base,
      party: null,
      reason: 'MASKED_PREDICATE',
    };
  }

  const party = identifyParty(
    transfer.senderAddress,
    resolvedPartyAAddress,
    resolvedPartyBAddress,
  );

  if (party === null) {
    return {
      ...base,
      party: null,
      reason: 'UNKNOWN_SENDER',
    };
  }

  const currencyValid = validateCurrency(party, transfer.coinId, manifest);
  if (!currencyValid) {
    return {
      ...base,
      party,
      reason: 'WRONG_CURRENCY',
    };
  }

  // Valid deposit — no reason field
  return {
    ...base,
    party,
  };
}
