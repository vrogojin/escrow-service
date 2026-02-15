import { describe, it, expect, beforeEach } from 'vitest';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import { createTestManifest, createMockTransfer } from '../helpers/mock-sphere.js';
import { SwapState } from '../../core/state-machine.js';

describe('E2E Happy Path', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  // ---------------------------------------------------------------------------
  // Complete Swap with Nametag Addresses
  // ---------------------------------------------------------------------------
  describe('Complete Swap with Nametag Addresses', () => {
    it('should complete a full swap lifecycle: announce -> A deposits -> B deposits -> conclusion -> COMPLETED', async () => {
      const manifest = createTestManifest();

      // Announce
      const { swapCase, isNew } = await ctx.swapManager.announceSwap(manifest);
      expect(isNew).toBe(true);
      expect(swapCase.swap_id).toBe(manifest.swap_id);
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
    });

    it('should transition through states ANNOUNCED -> PARTIAL_DEPOSIT -> COMPLETED at each step', async () => {
      const manifest = createTestManifest();

      await ctx.swapManager.announceSwap(manifest);

      // Verify ANNOUNCED
      const step1 = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(step1?.state).toBe(SwapState.ANNOUNCED);

      // Party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Verify PARTIAL_DEPOSIT
      const step2 = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(step2?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Party B deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      // Verify COMPLETED (passed through READY_TO_CONCLUDE and CONCLUDING internally)
      const step3 = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(step3?.state).toBe(SwapState.COMPLETED);
    });

    it('should send correct cross-payment amounts to each party', async () => {
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

      // Party A (@alice) receives EUR 900 (Party B's currency/value)
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({ recipient: '@alice', amount: '900', coinId: 'EUR' }),
      );
      // Party B (@bob) receives USD 1000 (Party A's currency/value)
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({ recipient: '@bob', amount: '1000', coinId: 'USD' }),
      );
    });

    it('should create deposit records for both parties', async () => {
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

      const partyADeposit = deposits.find((d) => d.matched_party === 'A');
      const partyBDeposit = deposits.find((d) => d.matched_party === 'B');

      expect(partyADeposit).toBeDefined();
      expect(partyADeposit?.sender).toBe('@alice');
      expect(partyADeposit?.amount).toBe('1000');
      expect(partyADeposit?.coin_id).toBe('USD');

      expect(partyBDeposit).toBeDefined();
      expect(partyBDeposit?.sender).toBe('@bob');
      expect(partyBDeposit?.amount).toBe('900');
      expect(partyBDeposit?.coin_id).toBe('EUR');
    });

    it('should record complete transaction logs for DEPOSIT and CROSS_PAYMENT', async () => {
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

      const allLogs = await ctx.txRepo.findBySwapId(manifest.swap_id);
      const depositLogs = allLogs.filter((l) => l.type === 'DEPOSIT');
      const crossPaymentLogs = allLogs.filter((l) => l.type === 'CROSS_PAYMENT');

      // Two deposits (A and B)
      expect(depositLogs).toHaveLength(2);
      expect(depositLogs.every((l) => l.direction === 'INCOMING')).toBe(true);
      expect(depositLogs.every((l) => l.status === 'CONFIRMED')).toBe(true);

      // Two cross-payments (to A and to B)
      expect(crossPaymentLogs).toHaveLength(2);
      expect(crossPaymentLogs.every((l) => l.direction === 'OUTGOING')).toBe(true);

      const payToAlice = crossPaymentLogs.find((l) => l.recipient === '@alice');
      const payToBob = crossPaymentLogs.find((l) => l.recipient === '@bob');

      expect(payToAlice?.amount).toBe('900');
      expect(payToAlice?.coin_id).toBe('EUR');
      expect(payToBob?.amount).toBe('1000');
      expect(payToBob?.coin_id).toBe('USD');
    });
  });

  // ---------------------------------------------------------------------------
  // Complete Swap with DIRECT:// Addresses
  // ---------------------------------------------------------------------------
  describe('Complete Swap with DIRECT:// Addresses', () => {
    it('should complete a full swap lifecycle using DIRECT:// addresses', async () => {
      const partyAPubkey = 'aabb'.repeat(16) + 'ab';
      const partyBPubkey = 'ccdd'.repeat(16) + 'cd';

      const manifest = createTestManifest({
        party_a_address: `DIRECT://${partyAPubkey}`,
        party_b_address: `DIRECT://${partyBPubkey}`,
      });

      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits (senderPubkey matches DIRECT:// address, no senderNametag)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderPubkey: partyAPubkey,
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterA?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(afterA?.party_a_deposited).toBe('1000');

      // Party B deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderPubkey: partyBPubkey,
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);

      // Cross-payments should go to DIRECT:// addresses
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({
          recipient: `DIRECT://${partyAPubkey}`,
          amount: '900',
          coinId: 'EUR',
        }),
      );
      expect(ctx.sentPayments).toContainEqual(
        expect.objectContaining({
          recipient: `DIRECT://${partyBPubkey}`,
          amount: '1000',
          coinId: 'USD',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Overpayment Handling
  // ---------------------------------------------------------------------------
  describe('Overpayment Handling', () => {
    it('should return surplus when party A overpays and still complete the swap', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits 1500 instead of required 1000
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1500' }],
        }),
      );

      // Surplus of 500 returned immediately during deposit processing
      const surplusAfterA = ctx.sentPayments.filter((p) => p.memo?.includes('Surplus'));
      expect(surplusAfterA).toHaveLength(1);
      expect(surplusAfterA[0]).toEqual(
        expect.objectContaining({ recipient: '@alice', amount: '500', coinId: 'USD' }),
      );

      // Deposited should be capped at the expected amount
      const swapAfterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swapAfterA?.party_a_deposited).toBe('1000');

      // Party B deposits exact amount
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

    it('should return surplus when party B overpays and still complete the swap', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits exact amount
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Party B deposits 1200 instead of required 900
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '1200' }],
        }),
      );
      await ctx.waitForConclusion();

      const surplusPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Surplus'));
      // Surplus of 300 returned to bob
      const bobSurplus = surplusPayments.filter((p) => p.recipient === '@bob');
      expect(bobSurplus.length).toBeGreaterThanOrEqual(1);

      const totalBobSurplus = bobSurplus.reduce((sum, p) => sum + BigInt(p.amount), 0n);
      expect(totalBobSurplus).toBe(300n);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });

    it('should return surplus to both parties when both overpay', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits 1500 (surplus 500)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1500' }],
        }),
      );

      // Party B deposits 1200 (surplus 300)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '1200' }],
        }),
      );
      await ctx.waitForConclusion();

      const surplusPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Surplus'));

      const aliceSurplus = surplusPayments.filter((p) => p.recipient === '@alice');
      const bobSurplus = surplusPayments.filter((p) => p.recipient === '@bob');

      const totalAliceSurplus = aliceSurplus.reduce((sum, p) => sum + BigInt(p.amount), 0n);
      const totalBobSurplus = bobSurplus.reduce((sum, p) => sum + BigInt(p.amount), 0n);

      expect(totalAliceSurplus).toBe(500n);
      expect(totalBobSurplus).toBe(300n);

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });

    it('should calculate surplus amounts correctly', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A deposits 1234 instead of 1000 -> surplus = 234
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1234' }],
        }),
      );

      const surplusPayments = ctx.sentPayments.filter((p) => p.memo?.includes('Surplus'));
      expect(surplusPayments).toHaveLength(1);
      expect(surplusPayments[0].amount).toBe('234');
      expect(surplusPayments[0].coinId).toBe('USD');
      expect(surplusPayments[0].recipient).toBe('@alice');

      // Effective deposit should be exactly the expected amount
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.party_a_deposited).toBe('1000');
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate Manifest
  // ---------------------------------------------------------------------------
  describe('Duplicate Manifest', () => {
    it('should return isNew: false when submitting the same manifest twice', async () => {
      const manifest = createTestManifest();

      const first = await ctx.swapManager.announceSwap(manifest);
      const second = await ctx.swapManager.announceSwap(manifest);

      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(second.swapCase.swap_id).toBe(first.swapCase.swap_id);
    });

    it('should preserve the original swap state after duplicate submission', async () => {
      const manifest = createTestManifest();

      await ctx.swapManager.announceSwap(manifest);

      // Make a deposit to change state
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      // Submit manifest again
      const duplicate = await ctx.swapManager.announceSwap(manifest);

      expect(duplicate.isNew).toBe(false);
      expect(duplicate.swapCase.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(duplicate.swapCase.party_a_deposited).toBe('1000');
    });

    it('should still allow deposits after duplicate manifest submission', async () => {
      const manifest = createTestManifest();

      await ctx.swapManager.announceSwap(manifest);
      await ctx.swapManager.announceSwap(manifest); // duplicate

      // Party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');

      // Party B deposits
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

  // ---------------------------------------------------------------------------
  // Multiple Independent Swaps
  // ---------------------------------------------------------------------------
  describe('Multiple Independent Swaps', () => {
    it('should run 3 swaps simultaneously with different parties and currencies', async () => {
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: '@carol',
        party_b_address: '@dave',
        party_a_currency_to_change: 'GBP',
        party_a_value_to_change: '500',
        party_b_currency_to_change: 'JPY',
        party_b_value_to_change: '75000',
      });
      const manifest3 = createTestManifest({
        party_a_address: '@eve',
        party_b_address: '@frank',
        party_a_currency_to_change: 'CHF',
        party_a_value_to_change: '2000',
        party_b_currency_to_change: 'BTC',
        party_b_value_to_change: '1',
      });

      await ctx.swapManager.announceSwap(manifest1);
      await ctx.swapManager.announceSwap(manifest2);
      await ctx.swapManager.announceSwap(manifest3);

      // Deposit for all three swaps - party A first
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'carol',
          tokenOverrides: [{ coinId: 'GBP', amount: '500' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest3.swap_id,
          senderNametag: 'eve',
          tokenOverrides: [{ coinId: 'CHF', amount: '2000' }],
        }),
      );

      // All should be in PARTIAL_DEPOSIT
      const swap1mid = await ctx.swapManager.getSwap(manifest1.swap_id);
      const swap2mid = await ctx.swapManager.getSwap(manifest2.swap_id);
      const swap3mid = await ctx.swapManager.getSwap(manifest3.swap_id);
      expect(swap1mid?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap2mid?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap3mid?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Deposit party B for all three
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'dave',
          tokenOverrides: [{ coinId: 'JPY', amount: '75000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest3.swap_id,
          senderNametag: 'frank',
          tokenOverrides: [{ coinId: 'BTC', amount: '1' }],
        }),
      );
      await ctx.waitForConclusion();

      // All should be COMPLETED
      const swap1 = await ctx.swapManager.getSwap(manifest1.swap_id);
      const swap2 = await ctx.swapManager.getSwap(manifest2.swap_id);
      const swap3 = await ctx.swapManager.getSwap(manifest3.swap_id);
      expect(swap1?.state).toBe(SwapState.COMPLETED);
      expect(swap2?.state).toBe(SwapState.COMPLETED);
      expect(swap3?.state).toBe(SwapState.COMPLETED);
    });

    it('should not mix cross-payments between swaps', async () => {
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: '@carol',
        party_b_address: '@dave',
        party_a_currency_to_change: 'GBP',
        party_a_value_to_change: '500',
        party_b_currency_to_change: 'JPY',
        party_b_value_to_change: '75000',
      });

      await ctx.swapManager.announceSwap(manifest1);
      await ctx.swapManager.announceSwap(manifest2);

      // Complete swap 1
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );

      // Complete swap 2
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'carol',
          tokenOverrides: [{ coinId: 'GBP', amount: '500' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest2.swap_id,
          senderNametag: 'dave',
          tokenOverrides: [{ coinId: 'JPY', amount: '75000' }],
        }),
      );
      await ctx.waitForConclusion();

      // Verify swap 1 cross-payments
      const swap1Logs = await ctx.txRepo.findBySwapIdAndType(manifest1.swap_id, 'CROSS_PAYMENT');
      expect(swap1Logs).toHaveLength(2);
      expect(swap1Logs.find((l) => l.recipient === '@alice')?.coin_id).toBe('EUR');
      expect(swap1Logs.find((l) => l.recipient === '@bob')?.coin_id).toBe('USD');

      // Verify swap 2 cross-payments
      const swap2Logs = await ctx.txRepo.findBySwapIdAndType(manifest2.swap_id, 'CROSS_PAYMENT');
      expect(swap2Logs).toHaveLength(2);
      expect(swap2Logs.find((l) => l.recipient === '@carol')?.coin_id).toBe('JPY');
      expect(swap2Logs.find((l) => l.recipient === '@dave')?.coin_id).toBe('GBP');

      // Ensure no cross-contamination: alice should never receive JPY, carol never EUR
      const allCrossPayments = ctx.sentPayments.filter((p) => p.memo?.includes('payout'));
      expect(allCrossPayments.filter((p) => p.recipient === '@alice' && p.coinId === 'JPY')).toHaveLength(0);
      expect(allCrossPayments.filter((p) => p.recipient === '@carol' && p.coinId === 'EUR')).toHaveLength(0);
    });

    it('should track state of each swap independently', async () => {
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: '@carol',
        party_b_address: '@dave',
        party_a_currency_to_change: 'GBP',
        party_a_value_to_change: '500',
        party_b_currency_to_change: 'JPY',
        party_b_value_to_change: '75000',
      });

      await ctx.swapManager.announceSwap(manifest1);
      await ctx.swapManager.announceSwap(manifest2);

      // Only deposit on swap 1
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest1.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      // Swap 1 is completed, swap 2 is still announced
      const swap1 = await ctx.swapManager.getSwap(manifest1.swap_id);
      const swap2 = await ctx.swapManager.getSwap(manifest2.swap_id);
      expect(swap1?.state).toBe(SwapState.COMPLETED);
      expect(swap2?.state).toBe(SwapState.ANNOUNCED);
    });
  });

  // ---------------------------------------------------------------------------
  // State Tracking
  // ---------------------------------------------------------------------------
  describe('State Tracking', () => {
    it('should set first_deposit_at on the first deposit', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const beforeDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(beforeDeposit?.first_deposit_at).toBeNull();

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.first_deposit_at).toBeInstanceOf(Date);
      expect(afterDeposit?.first_deposit_at!.getTime()).toBeGreaterThan(0);
    });

    it('should set timeout_at on the first deposit', async () => {
      const manifest = createTestManifest(); // timeout = 3600
      await ctx.swapManager.announceSwap(manifest);

      const beforeDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(beforeDeposit?.timeout_at).toBeNull();

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterDeposit = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterDeposit?.timeout_at).toBeInstanceOf(Date);

      // timeout_at should be approximately now + 3600 seconds
      const expectedTimeout = Date.now() + 3600 * 1000;
      const actualTimeout = afterDeposit?.timeout_at!.getTime() ?? 0;
      expect(Math.abs(actualTimeout - expectedTimeout)).toBeLessThan(5000); // within 5s tolerance
    });

    it('should set completed_at on completion', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const midway = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(midway?.completed_at).toBeNull();

      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.completed_at).toBeInstanceOf(Date);
      expect(final?.completed_at!.getTime()).toBeGreaterThan(0);
    });

    it('should track deposit amounts per party correctly', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Before any deposits
      const initial = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(initial?.party_a_deposited).toBe('0');
      expect(initial?.party_b_deposited).toBe('0');

      // Party A deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000' }],
        }),
      );

      const afterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterA?.party_a_deposited).toBe('1000');
      expect(afterA?.party_b_deposited).toBe('0');

      // Party B deposits
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900' }],
        }),
      );
      await ctx.waitForConclusion();

      const afterBoth = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterBoth?.party_a_deposited).toBe('1000');
      expect(afterBoth?.party_b_deposited).toBe('900');
    });
  });
});
