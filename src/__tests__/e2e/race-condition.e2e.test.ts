import { describe, it, expect, beforeEach } from 'vitest';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import { createTestManifest, createMockTransfer } from '../helpers/mock-sphere.js';
import { SwapState } from '../../core/state-machine.js';

describe('E2E Race Conditions', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  // ---------------------------------------------------------------------------
  // Simultaneous Deposits
  // ---------------------------------------------------------------------------
  describe('Simultaneous Deposits', () => {
    it('should complete swap when both parties deposit in rapid succession', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Both parties deposit. Under the distributed lock, these serialize
      // at await points, but the state machine must handle the full
      // ANNOUNCED -> PARTIAL_DEPOSIT -> READY_TO_CONCLUDE progression.
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

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.COMPLETED);
      expect(swap?.completed_at).toBeTruthy();
    });

    it('should trigger exactly one conclusion when both deposits complete', async () => {
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

      // Even if a second conclude() is called, the state check prevents
      // re-execution since state is no longer READY_TO_CONCLUDE.
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const crossPaymentLogs = (await ctx.txRepo.findBySwapIdAndType(manifest.swap_id, 'CROSS_PAYMENT'))
        .filter((l) => l.status === 'SENT');
      expect(crossPaymentLogs).toHaveLength(2);
    });

    it('should send cross-payments exactly once', async () => {
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

      const payoutPayments = ctx.sentPayments.filter((p) => p.memo?.includes('payout'));
      expect(payoutPayments).toHaveLength(2);

      const recipients = payoutPayments.map((p) => p.recipient).sort();
      expect(recipients).toEqual(['@alice', '@bob']);
    });

    it('should record exactly 2 deposit entries', async () => {
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

      const deposits = await ctx.depositRepo.findBySwapId(manifest.swap_id);
      expect(deposits).toHaveLength(2);

      const parties = deposits.map((d) => d.matched_party).sort();
      expect(parties).toEqual(['A', 'B']);
    });

    it('should not produce duplicate cross-payments in transaction logs', async () => {
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

      // Force a second conclusion attempt to verify idempotency
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const allLogs = await ctx.txRepo.findBySwapId(manifest.swap_id);
      const crossPaymentLogs = allLogs.filter((l) => l.type === 'CROSS_PAYMENT');

      // Exactly 2 cross-payment records, one per party
      expect(crossPaymentLogs).toHaveLength(2);

      const crossRecipients = crossPaymentLogs.map((l) => l.recipient).sort();
      expect(crossRecipients).toEqual(['@alice', '@bob']);
    });
  });

  // ---------------------------------------------------------------------------
  // Deposit on Concluding Swap
  // ---------------------------------------------------------------------------
  describe('Deposit on Concluding Swap', () => {
    it('should bounce a late deposit with SWAP_CLOSED after conclusion completes', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Both parties deposit, triggering conclusion
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

      // Third deposit arrives after the swap is COMPLETED.
      // Use a unique transfer id to avoid idempotency-dedup with the first Alice deposit.
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'late_alice_transfer',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '500' }],
        }),
      );

      const closedBounces = ctx.sentPayments.filter((p) => p.memo?.includes('SWAP_CLOSED'));
      expect(closedBounces).toHaveLength(1);
      expect(closedBounces[0].amount).toBe('500');
    });

    it('should remain in COMPLETED state after a late deposit attempt', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'alice_deposit_2',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'bob_deposit_2',
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      // Late deposit should not corrupt the state.
      // Use a unique transfer id.
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'late_bob_transfer',
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '200' }],
        }),
      );

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.COMPLETED);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout vs Second Deposit Race
  // ---------------------------------------------------------------------------
  describe('Timeout vs Second Deposit Race', () => {
    it('should complete swap when second deposit arrives before timeout fires', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits -- timeout is scheduled
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterA?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Party B deposits before timeout fires
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.COMPLETED);
    });

    it('should skip timeout when swap already completed via second deposit', async () => {
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

      // processTimeout arrives late -- swap is COMPLETED, not PARTIAL_DEPOSIT
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const afterTimeout = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterTimeout?.state).toBe(SwapState.COMPLETED);

      // No refund payments should have been sent
      const refundPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refundPayments).toHaveLength(0);
    });

    it('should refund when timeout fires before second deposit', async () => {
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

      // Timeout fires before B deposits
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.REFUNDED);

      const refundPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should bounce party B deposit after timeout-triggered refund', async () => {
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

      // Timeout fires, transitions to REFUNDED
      await ctx.refundProcessor.processTimeout(manifest.swap_id);

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.REFUNDED);

      // Party B tries to deposit on the now-REFUNDED swap
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      const closedBounces = ctx.sentPayments.filter((p) => p.memo?.includes('SWAP_CLOSED'));
      expect(closedBounces).toHaveLength(1);
      expect(closedBounces[0].amount).toBe('900');
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate Conclusion Attempts
  // ---------------------------------------------------------------------------
  describe('Duplicate Conclusion Attempts', () => {
    it('should only succeed on the first of two conclude() calls', async () => {
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

      const swapAfterFirst = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapAfterFirst?.state).toBe(SwapState.COMPLETED);

      // Second explicit conclude() finds state != READY_TO_CONCLUDE and returns
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const swapAfterSecond = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapAfterSecond?.state).toBe(SwapState.COMPLETED);
    });

    it('should not produce additional cross-payments on duplicate conclude', async () => {
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

      const payoutsBefore = ctx.sentPayments.filter((p) => p.memo?.includes('payout')).length;

      // Second conclude attempt
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const payoutsAfter = ctx.sentPayments.filter((p) => p.memo?.includes('payout')).length;
      expect(payoutsAfter).toBe(payoutsBefore);
      expect(payoutsAfter).toBe(2);
    });

    it('should skip conclude() on an already COMPLETED swap without version change', async () => {
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

      const swapBefore = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapBefore?.state).toBe(SwapState.COMPLETED);
      const versionBefore = swapBefore?.version;

      // Conclude on already COMPLETED swap should be a no-op
      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const swapAfter = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapAfter?.state).toBe(SwapState.COMPLETED);
      expect(swapAfter?.version).toBe(versionBefore);
    });

    it('should skip conclude() on a FAILED swap', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Mark the swap as FAILED directly
      await ctx.swapManager.markFailed(manifest.swap_id, 'Test failure');

      const swapBefore = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapBefore?.state).toBe(SwapState.FAILED);

      await ctx.conclusionProcessor.conclude(manifest.swap_id);

      const swapAfter = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapAfter?.state).toBe(SwapState.FAILED);

      // No cross-payments should have been sent
      const payoutPayments = ctx.sentPayments.filter((p) => p.memo?.includes('payout'));
      expect(payoutPayments).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent Swap Announcements
  // ---------------------------------------------------------------------------
  describe('Concurrent Swap Announcements', () => {
    it('should return isNew:false on the second sequential announcement of the same manifest', async () => {
      const manifest = createTestManifest();

      const result1 = await ctx.swapManager.announceSwap(manifest);
      const result2 = await ctx.swapManager.announceSwap(manifest);

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);

      expect(result1.swapCase.swap_id).toBe(manifest.swap_id);
      expect(result2.swapCase.swap_id).toBe(manifest.swap_id);
    });

    it('should maintain only one active swap case after repeated announcements', async () => {
      const manifest = createTestManifest();

      await ctx.swapManager.announceSwap(manifest);
      await ctx.swapManager.announceSwap(manifest);
      await ctx.swapManager.announceSwap(manifest);

      // All three announcements should result in the same single swap
      const announcedSwaps = await ctx.swapRepo.findByState(SwapState.ANNOUNCED);
      expect(announcedSwaps).toHaveLength(1);
      expect(announcedSwaps[0].swap_id).toBe(manifest.swap_id);
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery Scenarios
  // ---------------------------------------------------------------------------
  describe('Recovery Scenarios', () => {
    it('should complete refund via retryRefund on a REFUNDING swap', async () => {
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

      // Simulate a swap stuck in REFUNDING (e.g., process crashed after
      // transitioning to REFUNDING but before sending the refund payment).
      // Manually transition: PARTIAL_DEPOSIT -> TIMED_OUT -> REFUNDING.
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      const v1 = await ctx.swapRepo.updateState(
        manifest.swap_id,
        SwapState.TIMED_OUT,
        swap!.version,
      );
      const v2 = await ctx.swapRepo.updateState(
        manifest.swap_id,
        SwapState.REFUNDING,
        v1!.version,
      );
      expect(v2?.state).toBe(SwapState.REFUNDING);

      // retryRefund picks it up and completes the refund
      await ctx.refundProcessor.retryRefund(manifest.swap_id);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.REFUNDED);

      const refundPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should skip retryRefund on a swap not in REFUNDING state', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Swap is ANNOUNCED, not REFUNDING
      await ctx.refundProcessor.retryRefund(manifest.swap_id);

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.ANNOUNCED);

      // No refund payments should have been sent
      const refundPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Refund'));
      expect(refundPayments).toHaveLength(0);
    });

    it('should skip conclude() on a CONCLUDING swap (not READY_TO_CONCLUDE)', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Both parties deposit to reach READY_TO_CONCLUDE
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

      // The auto-triggered conclusion runs and completes, so manually
      // create a second swap and force it into CONCLUDING to test the guard.
      await ctx.waitForConclusion();

      const manifest2 = createTestManifest({ party_a_address: '@carol', party_b_address: '@dave' });
      await ctx.swapManager.announceSwap(manifest2);

      // Manually transition ANNOUNCED -> READY_TO_CONCLUDE -> CONCLUDING
      // to simulate a swap stuck in CONCLUDING state.
      const swap2 = await ctx.swapManager.getSwap(manifest2.swap_id);
      const r1 = await ctx.swapRepo.updateState(
        manifest2.swap_id,
        SwapState.PARTIAL_DEPOSIT,
        swap2!.version,
      );
      const r2 = await ctx.swapRepo.updateState(
        manifest2.swap_id,
        SwapState.READY_TO_CONCLUDE,
        r1!.version,
      );
      const r3 = await ctx.swapRepo.updateState(
        manifest2.swap_id,
        SwapState.CONCLUDING,
        r2!.version,
      );
      expect(r3?.state).toBe(SwapState.CONCLUDING);

      // conclude() should find state = CONCLUDING (not READY_TO_CONCLUDE) and skip
      await ctx.conclusionProcessor.conclude(manifest2.swap_id);

      const finalSwap = await ctx.swapManager.getSwap(manifest2.swap_id);
      expect(finalSwap?.state).toBe(SwapState.CONCLUDING);

      // No cross-payments should have been sent for this swap
      const payoutsForSwap2 = ctx.sentPayments.filter(
        (p) => p.memo?.includes(manifest2.swap_id) && p.memo?.includes('payout'),
      );
      expect(payoutsForSwap2).toHaveLength(0);
    });
  });
});
