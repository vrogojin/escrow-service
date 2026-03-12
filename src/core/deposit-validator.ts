/**
 * Deposit Validator
 *
 * Pure functions for validating deposit payments per architecture.md §Deposit Validation.
 *
 * Party identification is by ASSET/CURRENCY TYPE, not by sender address.
 * Anyone can deposit on behalf of A or B — if the coinId matches
 * party_a_currency_to_change, the deposit goes toward A's side (asset slot 0);
 * if it matches party_b_currency_to_change, it goes toward B's side (asset slot 1).
 *
 * The only bounce reason is WRONG_CURRENCY — a coinId that matches neither expected asset.
 * Surplus and refunds are routed to the original payer via effectiveSender.
 */

import type { InvoiceTransferRef } from './accounting-types.js';
import type { SwapManifest } from './manifest-validator.js';
import type { DepositValidationResult } from './types.js';

/**
 * Identifies which party side a deposit contributes to based on coinId.
 *
 * @param coinId - The coinId from the transfer.
 * @param manifest - The swap manifest.
 * @returns 'A' if coinId matches party_a_currency, 'B' if party_b_currency, null if neither.
 */
export function identifyPartySide(
  coinId: string,
  manifest: SwapManifest,
): 'A' | 'B' | null {
  if (coinId === manifest.party_a_currency_to_change) {
    return 'A';
  }
  if (coinId === manifest.party_b_currency_to_change) {
    return 'B';
  }
  return null;
}

/**
 * Returns the effective sender address for return routing.
 *
 * This is refundAddress ?? senderAddress, following the SDK's senderBalances
 * keying convention (effectiveSender). Both fields can be null/undefined —
 * if both are absent, returns null (cannot route return).
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
 * Checks that the transfer's coinId matches one of the two expected currencies.
 * Sender identity is NOT checked — anyone can deposit.
 *
 * Masked predicates (senderAddress === null) are accepted when the currency
 * matches. If a masked deposit has no refundAddress, surplus return may require
 * manual intervention — but the deposit itself is valid per architecture spec.
 *
 * @param transfer - The invoice transfer reference from getInvoiceStatus().
 * @param manifest - The swap manifest.
 * @returns DepositValidationResult with party side and optional rejection reason.
 */
export function validateDeposit(
  transfer: InvoiceTransferRef,
  manifest: SwapManifest,
): DepositValidationResult {
  const base: Omit<DepositValidationResult, 'partySide' | 'reason'> = {
    effectiveSender: getEffectiveSender(transfer),
    coinId: transfer.coinId,
    amount: transfer.amount,
    transferId: transfer.transferId,
  };

  const side = identifyPartySide(transfer.coinId, manifest);

  if (side === null) {
    return {
      ...base,
      partySide: null,
      reason: 'WRONG_CURRENCY',
    };
  }

  // Valid deposit — no reason field
  return {
    ...base,
    partySide: side,
  };
}
