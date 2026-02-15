import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import { createTestManifest, createMockTransfer } from '../helpers/mock-sphere.js';
import { SwapState } from '../../core/state-machine.js';
import { ManifestValidationError, SwapLimitError } from '../../core/swap-manager.js';

describe('E2E Failure Path', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  // ---------------------------------------------------------------------------
  // Timeout Scenarios
  // ---------------------------------------------------------------------------
  describe('Timeout Scenarios', () => {
    it('should refund party A when only A deposits and timeout fires', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Trigger timeout
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);

      const refunds = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should refund party B when only B deposits and timeout fires', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party B deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      const afterDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Trigger timeout
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);

      const refunds = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toEqual(
        expect.objectContaining({ recipient: '@bob', amount: '900', coinId: 'EUR' }),
      );
    });

    it('should skip timeout on ANNOUNCED swap (no deposits received)', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Swap is ANNOUNCED, not PARTIAL_DEPOSIT - processTimeout should be a no-op
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.ANNOUNCED);

      const refunds = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refunds).toHaveLength(0);
    });

    it('should create refund transaction logs correctly', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const refundLogs = await ctx.txRepo.findBySwapIdAndType(manifest.swap_id, 'REFUND');
      expect(refundLogs).toHaveLength(1);
      expect(refundLogs[0].type).toBe('REFUND');
      expect(refundLogs[0].direction).toBe('OUTGOING');
      expect(refundLogs[0].recipient).toBe('@alice');
      expect(refundLogs[0].amount).toBe('1000');
      expect(refundLogs[0].coin_id).toBe('USD');
      expect(refundLogs[0].status).toBe('SENT');
    });

    it('should transition through PARTIAL_DEPOSIT -> TIMED_OUT -> REFUNDING -> REFUNDED', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Deposit from A to reach PARTIAL_DEPOSIT
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // processTimeout transitions through TIMED_OUT -> REFUNDING internally,
      // then after successful refund payment, transitions to REFUNDED
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);
      expect(final?.completed_at).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Bounceback Scenarios
  // ---------------------------------------------------------------------------
  describe('Bounceback Scenarios', () => {
    it('should bounceback with INVALID_MEMO when memo is empty', async () => {
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: '',
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('INVALID_MEMO');
    });

    it('should bounceback with INVALID_MEMO when memo has spaces but no valid swap_id', async () => {
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: '   some random text with spaces   ',
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('INVALID_MEMO');
    });

    it('should bounceback with SWAP_NOT_FOUND for non-existent swap_id', async () => {
      const fakeSwapId = 'ab'.repeat(32);
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: fakeSwapId,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('SWAP_NOT_FOUND');
    });

    it('should bounceback with UNKNOWN_SENDER when sender is not party A or B', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'charlie',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('UNKNOWN_SENDER');
    });

    it('should bounceback with WRONG_CURRENCY when alice sends EUR instead of USD', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Alice is party A, expected currency is USD
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'EUR', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('WRONG_CURRENCY');
    });

    it('should bounceback with ALREADY_COVERED when party already fully deposited', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Alice deposits full amount
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Alice tries to deposit again (use unique transfer id to avoid idempotency check)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_second_attempt',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '500' }],
        }),
      );

      const bouncebacks = ctx.sentPayments.filter((p) => p.memo?.includes('ALREADY_COVERED'));
      expect(bouncebacks).toHaveLength(1);
      expect(bouncebacks[0].amount).toBe('500');
    });

    it('should bounceback with SWAP_CLOSED when depositing on COMPLETED swap', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Complete the swap
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'closed_swap_alice',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'closed_swap_bob',
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const completed = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(completed?.state).toBe(SwapState.COMPLETED);

      // Try to deposit on completed swap (unique id to avoid collision)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'closed_swap_late',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '500' }],
        }),
      );

      const closedBounce = ctx.sentPayments.filter((p) => p.memo?.includes('SWAP_CLOSED'));
      expect(closedBounce).toHaveLength(1);
    });

    it('should bounceback with SWAP_CLOSED when depositing on REFUNDED swap', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Trigger timeout -> REFUNDED
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const refunded = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(refunded?.state).toBe(SwapState.REFUNDED);

      // Try to deposit on refunded swap
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      const closedBounce = ctx.sentPayments.filter((p) => p.memo?.includes('SWAP_CLOSED'));
      expect(closedBounce).toHaveLength(1);
    });

    it('should return exact amount and currency to sender in bounceback', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Charlie sends a specific amount of GBP
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'charlie',
          tokenOverrides: [{ coinId: 'GBP', amount: '7777' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].amount).toBe('7777');
      expect(ctx.sentPayments[0].coinId).toBe('GBP');
      expect(ctx.sentPayments[0].recipient).toBe('@charlie');
      expect(ctx.sentPayments[0].memo).toContain('UNKNOWN_SENDER');
    });
  });

  // ---------------------------------------------------------------------------
  // Payment Failure during Conclusion
  // ---------------------------------------------------------------------------
  describe('Payment Failure during Conclusion', () => {
    async function setupReadyToConclude(): Promise<string> {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      // Wait for the automatic conclusion triggered by onReadyToConclude
      await ctx.waitForConclusion();

      // The swap should be COMPLETED now; we need to set it back to READY_TO_CONCLUDE
      // for our controlled test. Instead, let's set up the swap fresh without
      // the auto-conclude callback firing. We re-create context and manually
      // deposit + set state.
      // Actually, a simpler approach: create a fresh context, deposit both,
      // but override paymentSender BEFORE the second deposit so the auto-conclude
      // uses the failing sender. Let's restructure.

      // This helper won't work for failure tests. We need a different approach.
      return manifest.swap_id;
    }

    it('should complete swap when cross-payment fails on first attempt but succeeds on retry', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Deposit both parties manually without triggering auto-conclude
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      // Wait for the auto-triggered conclusion to finish (it will succeed with default mock)
      await ctx.waitForConclusion();

      // Verify it completed normally first
      const completed = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(completed?.state).toBe(SwapState.COMPLETED);

      // Now test with a fresh context where we control the conclusion manually
      const ctx2 = createIntegrationContext();
      const manifest2 = createTestManifest({
        party_a_address: '@alice2',
        party_b_address: '@bob2',
      });
      await ctx2.swapManager.announceSwap(manifest2);

      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'alice2',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'bob2',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx2.waitForConclusion();

      // The swap was auto-concluded successfully. Now let's test a fresh
      // scenario where the sender fails on the first attempt.
      const ctx3 = createIntegrationContext();
      const manifest3 = createTestManifest({
        party_a_address: '@party_a_fail_retry',
        party_b_address: '@party_b_fail_retry',
      });
      await ctx3.swapManager.announceSwap(manifest3);

      // Deposit both parties
      await ctx3.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest3.swap_id,
          senderNametag: 'party_a_fail_retry',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Before second deposit, override the payment sender to fail on first cross-payment call
      ctx3.sentPayments.length = 0;
      let callCount = 0;
      ctx3.paymentSender.send.mockImplementation(async (req: any) => {
        callCount++;
        if (callCount <= 1) throw new Error('Network error');
        ctx3.sentPayments.push(req);
        return { id: 'tx_retry_success', status: 'sent' } as any;
      });

      await ctx3.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest3.swap_id,
          senderNametag: 'party_b_fail_retry',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx3.waitForConclusion();

      const final = await ctx3.swapManager.getSwap(manifest3.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });

    it('should mark swap as FAILED when cross-payment fails all retries', async () => {
      const ctx2 = createIntegrationContext({ paymentRetryMaxAttempts: 3, paymentRetryDelayMs: 1 });
      const manifest = createTestManifest({
        party_a_address: '@alice_all_fail',
        party_b_address: '@bob_all_fail',
      });
      await ctx2.swapManager.announceSwap(manifest);

      // Deposit both parties
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice_all_fail',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Override payment sender to always fail BEFORE second deposit
      ctx2.sentPayments.length = 0;
      ctx2.paymentSender.send.mockImplementation(async () => {
        throw new Error('Permanent network error');
      });

      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob_all_fail',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      // The auto-conclude will be triggered but will throw after exhausting retries.
      // We need to wait and catch the rejection from concludePromises.
      try {
        await ctx2.waitForConclusion();
      } catch {
        // Expected: conclusion threw after exhausting retries
      }

      const final = await ctx2.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.FAILED);
      expect(final?.error_message).toContain('Cross-payment failed');
    });

    it('should retry exactly paymentRetryMaxAttempts times before failing', async () => {
      const maxAttempts = 3;
      const ctx2 = createIntegrationContext({
        paymentRetryMaxAttempts: maxAttempts,
        paymentRetryDelayMs: 1,
      });
      const manifest = createTestManifest({
        party_a_address: '@alice_retry_count',
        party_b_address: '@bob_retry_count',
      });
      await ctx2.swapManager.announceSwap(manifest);

      // Deposit party A
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice_retry_count',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Override sender to always fail and track call count
      ctx2.sentPayments.length = 0;
      let sendCallCount = 0;
      ctx2.paymentSender.send.mockImplementation(async () => {
        sendCallCount++;
        throw new Error('Retry test error');
      });

      // Deposit party B (triggers auto-conclude)
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob_retry_count',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      try {
        await ctx2.waitForConclusion();
      } catch {
        // Expected
      }

      // Each retry attempt calls send for the first cross-payment (to party A).
      // It fails on the first cross-payment each time, so total calls = maxAttempts.
      expect(sendCallCount).toBe(maxAttempts);
    });
  });

  // ---------------------------------------------------------------------------
  // Payment Failure during Refund
  // ---------------------------------------------------------------------------
  describe('Payment Failure during Refund', () => {
    it('should complete refund when payment fails on first attempt but succeeds on retry', async () => {
      const ctx2 = createIntegrationContext({ paymentRetryMaxAttempts: 3, paymentRetryDelayMs: 1 });
      const manifest = createTestManifest({
        party_a_address: '@alice_refund_retry',
        party_b_address: '@bob_refund_retry',
      });
      await ctx2.swapManager.announceSwap(manifest);

      // Party A deposits
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice_refund_retry',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx2.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Override payment sender: fail on first call, succeed on subsequent
      ctx2.sentPayments.length = 0;
      let callCount = 0;
      ctx2.paymentSender.send.mockImplementation(async (req: any) => {
        callCount++;
        if (callCount <= 1) throw new Error('Refund network error');
        ctx2.sentPayments.push(req);
        return { id: 'tx_refund_retry_ok', status: 'sent' } as any;
      });

      // Trigger timeout -> refund
      await ctx2.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx2.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);
    });

    it('should mark swap as FAILED when refund payment fails all retries', async () => {
      const ctx2 = createIntegrationContext({ paymentRetryMaxAttempts: 3, paymentRetryDelayMs: 1 });
      const manifest = createTestManifest({
        party_a_address: '@alice_refund_allfail',
        party_b_address: '@bob_refund_allfail',
      });
      await ctx2.swapManager.announceSwap(manifest);

      // Party A deposits
      await ctx2.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice_refund_allfail',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx2.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Override payment sender to always fail
      ctx2.sentPayments.length = 0;
      ctx2.paymentSender.send.mockImplementation(async () => {
        throw new Error('Permanent refund failure');
      });

      // Trigger timeout -> refund (will fail)
      await ctx2.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx2.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.FAILED);
      expect(final?.error_message).toContain('Refund failed');
    });
  });

  // ---------------------------------------------------------------------------
  // Manifest Validation Errors
  // ---------------------------------------------------------------------------
  describe('Manifest Validation Errors', () => {
    it('should throw ManifestValidationError for missing swap_id', async () => {
      const manifest = createTestManifest();
      const { swap_id, ...noId } = manifest;

      await expect(ctx.swapManager.announceSwap(noId as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });

    it('should throw ManifestValidationError for invalid swap_id (wrong hash)', async () => {
      const manifest = createTestManifest();
      const tampered = { ...manifest, swap_id: 'ff'.repeat(32) };

      await expect(ctx.swapManager.announceSwap(tampered as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });

    it('should throw ManifestValidationError when party A and B have same address', async () => {
      const manifest = createTestManifest({
        party_a_address: '@same_party',
        party_b_address: '@same_party',
      });

      await expect(ctx.swapManager.announceSwap(manifest as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });

    it('should throw ManifestValidationError when currencies are the same', async () => {
      const manifest = createTestManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'USD',
      });

      await expect(ctx.swapManager.announceSwap(manifest as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });

    it('should throw ManifestValidationError for zero value', async () => {
      const manifest = createTestManifest({
        party_a_value_to_change: '0',
      });

      await expect(ctx.swapManager.announceSwap(manifest as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });

    it('should throw ManifestValidationError for timeout out of range', async () => {
      // timeout too low (below swapTimeoutMin of 60)
      const manifestLow = createTestManifest({ timeout: 1 });
      await expect(ctx.swapManager.announceSwap(manifestLow as any)).rejects.toThrow(
        ManifestValidationError,
      );

      // timeout too high (above swapTimeoutMax of 86400)
      const manifestHigh = createTestManifest({ timeout: 999999 });
      await expect(ctx.swapManager.announceSwap(manifestHigh as any)).rejects.toThrow(
        ManifestValidationError,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Swap Limit
  // ---------------------------------------------------------------------------
  describe('Swap Limit', () => {
    it('should throw SwapLimitError when maxPendingSwaps is exceeded', async () => {
      const ctx2 = createIntegrationContext({ maxPendingSwaps: 1 });

      // First swap should succeed
      const manifest1 = createTestManifest();
      await ctx2.swapManager.announceSwap(manifest1);

      // Second swap should be rejected
      const manifest2 = createTestManifest({
        party_a_address: '@carol',
        party_b_address: '@dave',
        party_a_currency_to_change: 'GBP',
        party_a_value_to_change: '500',
      });

      await expect(ctx2.swapManager.announceSwap(manifest2)).rejects.toThrow(SwapLimitError);
    });
  });
});
