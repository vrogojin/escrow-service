import { vi } from 'vitest';
import type { WalletManager } from '../../sphere/wallet-manager.js';
import type { PaymentSender, SendPaymentRequest } from '../../sphere/payment-sender.js';
import type { PaymentListener, IncomingTransferHandler } from '../../sphere/payment-listener.js';
import type { IncomingTransfer, Token, TransferResult, DirectMessage } from '@unicitylabs/sphere-sdk';

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
 * Creates a mock Sphere with a working event emitter for testing confirmation wait.
 */
export function createMockSphereWithEvents() {
  const handlers = new Map<string, Set<Function>>();

  return {
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => {
        handlers.get(event)?.delete(handler);
      };
    },
    off(event: string, handler: Function) {
      handlers.get(event)?.delete(handler);
    },
    /** Emit an event (test-only helper, not part of real Sphere API). */
    emit(event: string, data: unknown) {
      handlers.get(event)?.forEach((h) => h(data));
    },
    /** Returns the number of listeners for a given event (test-only helper). */
    listenerCount(event: string): number {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

/**
 * Creates a mock Sphere with a working communications module for DM testing.
 */
export function createMockSphereWithCommunications() {
  const dmHandlers = new Set<(message: DirectMessage) => void>();
  const sentDMs: Array<{ recipient: string; content: string }> = [];

  const sendDM = vi.fn(async (recipient: string, content: string) => {
    sentDMs.push({ recipient, content });
    return {} as DirectMessage;
  });

  const onDirectMessage = vi.fn((handler: (message: DirectMessage) => void) => {
    dmHandlers.add(handler);
    return () => {
      dmHandlers.delete(handler);
    };
  });

  const communications = { sendDM, onDirectMessage };

  const sphere = {
    communications,
    on: vi.fn(),
    off: vi.fn(),
  };

  function createDM(senderPubkey: string, content: string): DirectMessage {
    return {
      id: `dm_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      senderPubkey,
      recipientPubkey: 'escrow_pubkey',
      content,
      timestamp: Date.now(),
      isRead: false,
    };
  }

  async function simulateDM(dm: DirectMessage): Promise<void> {
    const handlers = Array.from(dmHandlers);
    for (const handler of handlers) {
      handler(dm);
    }
    // Allow async handlers to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    sphere,
    communications,
    sendDM,
    onDirectMessage,
    sentDMs,
    createDM,
    simulateDM,
  };
}

/**
 * Creates a mock IncomingTransfer with submitted (unconfirmed) tokens.
 */
export function createSubmittedTransfer(overrides: Partial<IncomingTransfer> & {
  tokenOverrides?: Partial<Token>[];
} = {}): IncomingTransfer {
  const { tokenOverrides, ...rest } = overrides;
  const tokens: Token[] = tokenOverrides
    ? tokenOverrides.map((t, i) => ({
        id: `token_${i}`,
        coinId: 'USD',
        amount: '1000',
        status: 'submitted' as const,
        ...t,
      } as Token))
    : [{
        id: 'token_0',
        coinId: 'USD',
        amount: '1000',
        status: 'submitted' as const,
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
