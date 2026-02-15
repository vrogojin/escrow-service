import { describe, it, expect, beforeEach } from 'vitest';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import {
  createTestManifest,
  createMockTransfer,
  createSubmittedTransfer,
  createMockSphereWithEvents,
} from '../helpers/mock-sphere.js';
import { SwapState } from '../../core/state-machine.js';

describe('E2E Deposit Confirmation', () => {
  // ---------------------------------------------------------------------------
  // Already-confirmed tokens proceed immediately (no sphere needed)
  // ---------------------------------------------------------------------------
  describe('Already Confirmed Tokens', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = createIntegrationContext();
    });

    it('should process deposit immediately when all tokens are confirmed', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Default createMockTransfer creates tokens with status 'confirmed'
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000', status: 'confirmed' }],
        }),
      );

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');
    });
  });

  // ---------------------------------------------------------------------------
  // No sphere → skip confirmation wait (backward compatibility)
  // ---------------------------------------------------------------------------
  describe('No Sphere (backward compatibility)', () => {
    let ctx: TestContext;

    beforeEach(() => {
      // No sphere passed — confirmation wait is skipped
      ctx = createIntegrationContext();
    });

    it('should process submitted tokens immediately when sphere is not available', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Tokens with 'submitted' status but no sphere → processed immediately
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000', status: 'submitted' as any }],
        }),
      );

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');
    });
  });

  // ---------------------------------------------------------------------------
  // Submitted tokens with sphere → wait for confirmation
  // ---------------------------------------------------------------------------
  describe('Wait for Confirmation', () => {
    let ctx: TestContext;
    let mockSphere: ReturnType<typeof createMockSphereWithEvents>;

    beforeEach(() => {
      mockSphere = createMockSphereWithEvents();
      ctx = createIntegrationContext({}, { sphere: mockSphere });
    });

    it('should wait for transfer:confirmed event before processing deposit', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ id: 'tok_1', coinId: 'USD', amount: '1000', status: 'submitted' }],
      });

      // Start processing — will block waiting for confirmation
      const processPromise = ctx.paymentProcessor.processIncomingTransfer(transfer);

      // Verify the listener was registered
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(1);

      // Simulate SDK confirming the token after a short delay
      await new Promise((r) => setTimeout(r, 10));
      mockSphere.emit('transfer:confirmed', {
        id: 'confirmed_result',
        status: 'confirmed',
        tokens: [{ id: 'tok_1', coinId: 'USD', amount: '1000', status: 'confirmed' }],
        tokenTransfers: [],
      });

      await processPromise;

      // Deposit should have been processed
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');

      // Event listener should have been cleaned up
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(0);
    });

    it('should handle multiple tokens confirming in separate events', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [
          { id: 'tok_a', coinId: 'USD', amount: '600', status: 'submitted' },
          { id: 'tok_b', coinId: 'USD', amount: '400', status: 'submitted' },
        ],
      });

      const processPromise = ctx.paymentProcessor.processIncomingTransfer(transfer);

      // Confirm first token
      await new Promise((r) => setTimeout(r, 5));
      mockSphere.emit('transfer:confirmed', {
        id: 'r1',
        status: 'confirmed',
        tokens: [{ id: 'tok_a', coinId: 'USD', amount: '600', status: 'confirmed' }],
        tokenTransfers: [],
      });

      // Should still be waiting (tok_b not confirmed yet)
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(1);

      // Confirm second token
      await new Promise((r) => setTimeout(r, 5));
      mockSphere.emit('transfer:confirmed', {
        id: 'r2',
        status: 'confirmed',
        tokens: [{ id: 'tok_b', coinId: 'USD', amount: '400', status: 'confirmed' }],
        tokenTransfers: [],
      });

      await processPromise;

      // Both tokens aggregated: 600 + 400 = 1000
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');

      // Listener cleaned up
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(0);
    });

    it('should skip already confirmed tokens and only wait for submitted ones', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Mixed: one confirmed, one submitted
      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [
          { id: 'tok_confirmed', coinId: 'USD', amount: '600', status: 'confirmed' },
          { id: 'tok_pending', coinId: 'USD', amount: '400', status: 'submitted' },
        ],
      });

      const processPromise = ctx.paymentProcessor.processIncomingTransfer(transfer);

      // Only need to confirm tok_pending
      await new Promise((r) => setTimeout(r, 5));
      mockSphere.emit('transfer:confirmed', {
        id: 'r1',
        status: 'confirmed',
        tokens: [{ id: 'tok_pending', coinId: 'USD', amount: '400', status: 'confirmed' }],
        tokenTransfers: [],
      });

      await processPromise;

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');
    });

    it('should ignore transfer:confirmed events for unrelated tokens', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ id: 'tok_ours', coinId: 'USD', amount: '1000', status: 'submitted' }],
      });

      const processPromise = ctx.paymentProcessor.processIncomingTransfer(transfer);

      // Emit confirmation for a different token — should be ignored
      await new Promise((r) => setTimeout(r, 5));
      mockSphere.emit('transfer:confirmed', {
        id: 'unrelated',
        status: 'confirmed',
        tokens: [{ id: 'tok_other', coinId: 'EUR', amount: '500', status: 'confirmed' }],
        tokenTransfers: [],
      });

      // Still waiting
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(1);

      // Now confirm our token
      mockSphere.emit('transfer:confirmed', {
        id: 'ours',
        status: 'confirmed',
        tokens: [{ id: 'tok_ours', coinId: 'USD', amount: '1000', status: 'confirmed' }],
        tokenTransfers: [],
      });

      await processPromise;

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');
    });

    it('should complete full swap lifecycle with confirmed submitted tokens', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // Party A sends submitted tokens
      const transferA = createSubmittedTransfer({
        id: 'transfer_a',
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ id: 'tok_a', coinId: 'USD', amount: '1000', status: 'submitted' }],
      });

      const processA = ctx.paymentProcessor.processIncomingTransfer(transferA);

      await new Promise((r) => setTimeout(r, 5));
      mockSphere.emit('transfer:confirmed', {
        id: 'cr_a',
        status: 'confirmed',
        tokens: [{ id: 'tok_a', coinId: 'USD', amount: '1000', status: 'confirmed' }],
        tokenTransfers: [],
      });

      await processA;

      const afterA = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterA?.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Party B sends already-confirmed tokens (conservative mode)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'transfer_b',
          memo: manifest.swap_id,
          senderNametag: 'bob',
          tokenOverrides: [{ coinId: 'EUR', amount: '900', status: 'confirmed' }],
        }),
      );
      await ctx.waitForConclusion();

      const final = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(final?.state).toBe(SwapState.COMPLETED);
    });
  });

  // ---------------------------------------------------------------------------
  // Confirmation Timeout → Bounceback
  // ---------------------------------------------------------------------------
  describe('Confirmation Timeout', () => {
    let ctx: TestContext;
    let mockSphere: ReturnType<typeof createMockSphereWithEvents>;

    beforeEach(() => {
      mockSphere = createMockSphereWithEvents();
      // Use a very short timeout for test speed
      ctx = createIntegrationContext(
        { depositConfirmationTimeoutMs: 50 },
        { sphere: mockSphere },
      );
    });

    it('should bounce back all coins with UNCONFIRMED when confirmation times out', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ id: 'tok_1', coinId: 'USD', amount: '1000', status: 'submitted' }],
      });

      // Process — no confirmation event fires, so it will timeout
      await ctx.paymentProcessor.processIncomingTransfer(transfer);

      // Should bounce back with UNCONFIRMED
      const bounces = ctx.sentPayments.filter((p) => p.memo?.includes('UNCONFIRMED'));
      expect(bounces).toHaveLength(1);
      expect(bounces[0].amount).toBe('1000');
      expect(bounces[0].coinId).toBe('USD');
      expect(bounces[0].recipient).toBe('@alice');

      // No deposit should have been recorded
      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.ANNOUNCED);

      // Event listener should be cleaned up after timeout
      expect(mockSphere.listenerCount('transfer:confirmed')).toBe(0);
    });

    it('should bounce back multiple coin types when confirmation times out', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [
          { id: 'tok_usd', coinId: 'USD', amount: '500', status: 'submitted' },
          { id: 'tok_usd2', coinId: 'USD', amount: '500', status: 'submitted' },
        ],
      });

      await ctx.paymentProcessor.processIncomingTransfer(transfer);

      const bounces = ctx.sentPayments.filter((p) => p.memo?.includes('UNCONFIRMED'));
      expect(bounces).toHaveLength(1); // aggregated to one coin type
      expect(bounces[0].amount).toBe('1000');
      expect(bounces[0].coinId).toBe('USD');
    });

    it('should create bounceback transaction log for unconfirmed tokens', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      const transfer = createSubmittedTransfer({
        memo: manifest.swap_id,
        senderNametag: 'alice',
        tokenOverrides: [{ id: 'tok_1', coinId: 'USD', amount: '1000', status: 'submitted' }],
      });

      await ctx.paymentProcessor.processIncomingTransfer(transfer);

      const allLogs = ctx.txRepo.getAll();
      const bounceLogs = allLogs.filter(
        (l) => l.type === 'BOUNCEBACK' && l.memo?.includes('UNCONFIRMED'),
      );
      expect(bounceLogs).toHaveLength(1);
      expect(bounceLogs[0].amount).toBe('1000');
      expect(bounceLogs[0].coin_id).toBe('USD');
    });

    it('should not affect other deposits that are already confirmed', async () => {
      const manifest = createTestManifest();
      await ctx.swapManager.announceSwap(manifest);

      // First: confirmed deposit from alice (should succeed immediately)
      await ctx.paymentProcessor.processIncomingTransfer(
        createMockTransfer({
          id: 'confirmed_transfer',
          memo: manifest.swap_id,
          senderNametag: 'alice',
          tokenOverrides: [{ coinId: 'USD', amount: '1000', status: 'confirmed' }],
        }),
      );

      const afterConfirmed = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(afterConfirmed?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(afterConfirmed?.party_a_deposited).toBe('1000');

      // Second: unconfirmed deposit from bob (should timeout and bounce)
      const unconfirmedTransfer = createSubmittedTransfer({
        id: 'unconfirmed_transfer',
        memo: manifest.swap_id,
        senderNametag: 'bob',
        tokenOverrides: [{ id: 'tok_b', coinId: 'EUR', amount: '900', status: 'submitted' }],
      });

      await ctx.paymentProcessor.processIncomingTransfer(unconfirmedTransfer);

      // Bob's deposit bounced, alice's deposit still intact
      const bounces = ctx.sentPayments.filter((p) => p.memo?.includes('UNCONFIRMED'));
      expect(bounces).toHaveLength(1);
      expect(bounces[0].recipient).toBe('@bob');

      const swap = await ctx.swapManager.getSwap(manifest.swap_id);
      expect(swap?.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap?.party_a_deposited).toBe('1000');
      expect(swap?.party_b_deposited).toBe('0');
    });
  });
});
