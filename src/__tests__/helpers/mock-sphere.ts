import { vi } from 'vitest';
import type { WalletManager } from '../../sphere/wallet-manager.js';
import type { PaymentSender, SendPaymentRequest } from '../../sphere/payment-sender.js';
import type { PaymentListener, IncomingTransferHandler } from '../../sphere/payment-listener.js';
import type { IncomingTransfer, Token, TransferResult } from '@unicitylabs/sphere-sdk';

/**
 * Creates a mock WalletManager for testing.
 */
export function createMockWalletManager(escrowAddress = 'DIRECT://escrow_pubkey_hex'): WalletManager {
  return {
    getSphere: vi.fn().mockReturnValue({}),
    getEscrowAddress: vi.fn().mockReturnValue(escrowAddress),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock PaymentSender that records all sent payments.
 */
export function createMockPaymentSender(): PaymentSender & {
  sentPayments: SendPaymentRequest[];
  send: ReturnType<typeof vi.fn>;
} {
  const sentPayments: SendPaymentRequest[] = [];
  return {
    sentPayments,
    send: vi.fn().mockImplementation(async (request: SendPaymentRequest): Promise<TransferResult> => {
      sentPayments.push(request);
      return { id: `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`, status: 'sent' } as unknown as TransferResult;
    }),
  };
}

/**
 * Creates a mock PaymentListener that allows programmatic injection of transfers.
 */
export function createMockPaymentListener(): PaymentListener & {
  simulateTransfer: (transfer: IncomingTransfer) => Promise<void>;
} {
  let handler: IncomingTransferHandler | null = null;

  return {
    start(h: IncomingTransferHandler) {
      handler = h;
    },
    stop() {
      handler = null;
    },
    async simulateTransfer(transfer: IncomingTransfer) {
      if (!handler) throw new Error('PaymentListener not started');
      await handler(transfer);
    },
  };
}

/**
 * Creates a mock IncomingTransfer object.
 */
export function createMockTransfer(overrides: Partial<IncomingTransfer> & {
  tokenOverrides?: Partial<Token>[];
} = {}): IncomingTransfer {
  const { tokenOverrides, ...rest } = overrides;
  const tokens: Token[] = tokenOverrides
    ? tokenOverrides.map((t, i) => ({
        id: `token_${i}`,
        coinId: 'USD',
        amount: '1000',
        status: 'confirmed' as const,
        ...t,
      } as Token))
    : [{
        id: 'token_0',
        coinId: 'USD',
        amount: '1000',
        status: 'confirmed' as const,
      } as Token];

  return {
    id: `transfer_${Date.now()}`,
    senderPubkey: 'aabb'.repeat(16) + 'ab',
    tokens,
    receivedAt: Date.now(),
    ...rest,
  } as IncomingTransfer;
}

/**
 * Creates a valid swap manifest for testing.
 */
export function createTestManifest(overrides: Record<string, unknown> = {}): {
  swap_id: string;
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
} {
  // Import computeSwapId lazily to avoid circular deps
  const fields = {
    party_a_address: '@alice',
    party_b_address: '@bob',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '900',
    timeout: 3600,
    ...overrides,
  };
  // We compute a deterministic swap_id from fields
  const crypto = require('crypto');
  const canonicalize = require('canonicalize');
  const canonical = typeof canonicalize === 'function'
    ? canonicalize(fields)
    : canonicalize.default(fields);
  const swap_id = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...fields, swap_id };
}
