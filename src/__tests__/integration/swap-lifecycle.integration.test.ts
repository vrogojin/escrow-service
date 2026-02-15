import { describe, it, expect, beforeEach } from 'vitest';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import { createTestManifest, createMockTransfer } from '../helpers/mock-sphere.js';
import { SwapState } from '../../core/state-machine.js';

describe('Swap Lifecycle Integration', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  // -------------------------------------------------------------------------
  // Happy Path
  // -------------------------------------------------------------------------
  describe('Happy Path', () => {
    it('should complete a swap when party A deposits first, then party B', async () => {
      const manifest = createTestManifest();
      const { swapCase, isNew } = await ctx.swapManager.announceSwap(manifest);
      expect(isNew).toBe(true);
      expect(swapCase.state).toBe(SwapState.ANNOUNCED);

      // Party A deposits USD
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterA?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(afterA?.party_a_deposited).toBe('1000');

      // Party B deposits EUR
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
      expect(final?.completed_at).toBeTruthy();
    });

    it('should complete a swap when party B deposits first, then party A', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party B deposits first
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      const afterB = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterB?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(afterB?.party_b_deposited).toBe('900');

      // Then party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });

    it('should send cross-payments to the correct parties', async () => {
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
      await ctx.waitForConclusion();

      // Party A receives EUR (Party B's currency)
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({ recipient: '@alice', amount: '900', coinId: 'EUR' }),
      );
      // Party B receives USD (Party A's currency)
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({ recipient: '@bob', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should record transaction logs for the complete lifecycle', async () => {
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
      await ctx.waitForConclusion();

      const logs = await ctx.txRepo.findBySwapId(manifest.swap_id);
      const depositLogs = logs.filter((l) => l.type === 'DEPOSIT');
      const crossPaymentLogs = logs.filter((l) => l.type === 'CROSS_PAYMENT');

      expect(depositLogs).toHaveLength(2);
      expect(crossPaymentLogs).toHaveLength(2);
    });

    it('should handle duplicate manifest submission', async () => {
      const manifest = createTestManifest();
      const first = await ctx.swapManager.announceSwap(manifest);
      const second = await ctx.swapManager.announceSwap(manifest);

      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(second.swapCase.swap_id).toBe(first.swapCase.swap_id);
    });
  });

  // -------------------------------------------------------------------------
  // Bounceback Scenarios
  // -------------------------------------------------------------------------
  describe('Bounceback', () => {
    it('should bounce back payment with invalid memo', async () => {
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: 'not-a-valid-swap-id',
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('INVALID_MEMO');
    });

    it('should bounce back payment for unknown swap_id', async () => {
      const fakeSwapId = 'a'.repeat(64);
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

    it('should bounce back payment from unknown sender', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'charlie', // not alice or bob
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      expect(ctx.sentPayments).toHaveLength(1);
      expect(ctx.sentPayments[0].memo).toContain('UNKNOWN_SENDER');
    });

    it('should bounce back payment with wrong currency', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Alice is party A, expected to send USD, but sends EUR
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

    it('should bounce back payment for already covered party', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Alice deposits full amount
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_alice_1',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Alice tries to deposit again (explicit unique id to avoid Date.now collision)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_alice_2',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '500' }],
        }),
      );

      // First deposit produces no bounceback, second does
      const bouncebacks = ctx.sentPayments.filter((p) => p.memo?.includes('ALREADY_COVERED'));
      expect(bouncebacks).toHaveLength(1);
      expect(bouncebacks[0].amount).toBe('500');
    });

    it('should bounce back payment for closed swap (COMPLETED)', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Complete the swap
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_close_1',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_close_2',
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      // Try to deposit on completed swap (explicit unique id)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_close_3',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '500' }],
        }),
      );

      const closedBounce = ctx.sentPayments.filter((p) => p.memo?.includes('SWAP_CLOSED'));
      expect(closedBounce).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout and Refund
  // -------------------------------------------------------------------------
  describe('Timeout and Refund', () => {
    it('should refund party A on timeout when only A deposited', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Trigger timeout directly
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);

      const refunds = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should refund party B on timeout when only B deposited', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);

      const refunds = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toEqual(
        expect.objectContaining({ recipient: '@bob', amount: '900', coinId: 'EUR' }),
      );
    });

    it('should skip timeout for swap no longer in PARTIAL_DEPOSIT', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Both deposit → READY_TO_CONCLUDE
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
      await ctx.waitForConclusion();

      // Timeout fires but swap is already COMPLETED
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED); // Not refunded
    });

    it('should schedule timeout via Redis on first deposit', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Timeout should have been scheduled in Redis
      expect(ctx.redis.zadd).toHaveBeenCalledWith(
        'swap_timeouts',
        expect.any(Number),
        manifest.swap_id,
      );
    });

    it('should create refund transaction logs', async () => {
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
      expect(refundLogs[0].recipient).toBe('@alice');
      expect(refundLogs[0].amount).toBe('1000');
      expect(refundLogs[0].status).toBe('SENT');
    });
  });

  // -------------------------------------------------------------------------
  // Overpayment
  // -------------------------------------------------------------------------
  describe('Overpayment', () => {
    it('should return surplus when party A overpays', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits 1500 instead of 1000
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1500' }],
        }),
      );

      // Surplus of 500 should be returned immediately
      const surplusPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Surplus'));
      expect(surplusPayments).toHaveLength(1);
      expect(surplusPayments[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '500', coinId: 'USD' }),
      );

      // Deposited should be capped at expected (1000)
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.party_a_deposited).toBe('1000');
    });

    it('should complete swap after overpayment with surplus returned', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1500' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  describe('Idempotency', () => {
    it('should skip duplicate deposit with same transaction_id', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createMockTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
      });

      await ctx.paymentProcessor.processIncomingTransfer(transfer);
      await ctx.paymentProcessor.processIncomingTransfer(transfer); // same transfer

      const deposits = await ctx.depositRepo.findBySwapId(manifest.swap_id);
      expect(deposits).toHaveLength(1);

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.party_a_deposited).toBe('1000');
    });

    it('should not double cross-pay on repeated conclusion', async () => {
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
      await ctx.waitForConclusion();

      // Try concluding again — should be skipped because state is COMPLETED
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const crossPayments = ctx.sentPayments.filter((p) => p.memo?.includes('payout'));
      expect(crossPayments).toHaveLength(2); // Only the original 2
    });
  });

  // -------------------------------------------------------------------------
  // Multiple Swaps
  // -------------------------------------------------------------------------
  describe('Multiple Swaps', () => {
    it('should handle multiple independent swaps concurrently', async () => {
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: '@carol',
        party_b_address: '@dave',
        party_a_currency_to_change: 'GBP',
        party_a_value_to_change: '500',
      });

      await ctx.swapManager.announceSwap(manifest1);
      await ctx.swapManager.announceSwap(manifest2);

      // Deposit on swap 1
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Deposit on swap 2
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'carol',
          tokenOverrides: [{ coinId: 'GBP', amount: '500' }],
        }),
      );

      const swap1 = await ctx.swapManager.getSwap(manifest1.swap_id);
      const swap2 = await ctx.swapManager.getSwap(manifest2.swap_id);

      expect(swap1?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap1?.party_a_deposited).toBe('1000');
      expect(swap2?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap2?.party_a_deposited).toBe('500');
    });
  });
});
