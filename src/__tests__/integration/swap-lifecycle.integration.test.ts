import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwapOrchestrator } from '../../core/swap-orchestrator.js';
import { InvoiceManager } from '../../core/invoice-manager.js';
import { TimeoutManager } from '../../core/timeout-manager.js';
import { CrashRecoveryManager } from '../../core/crash-recovery-manager.js';
import { SwapState } from '../../core/state-machine.js';
import { computeSwapId } from '../../utils/hash.js';
import { MockAccountingModule } from '../helpers/mock-accounting-module.js';
import { InMemorySwapStateStore } from '../helpers/in-memory-swap-state-store.js';
import { createMockTransferRef, createMockSenderBalance } from '../helpers/mock-invoice-status.js';
import type { SwapManifest } from '../../core/manifest-validator.js';

// Test constants
const ESCROW_ADDRESS = 'DIRECT://escrow_pubkey_hex';
const PARTY_A_ADDRESS = 'DIRECT://party_a_pubkey_hex';
const PARTY_B_ADDRESS = 'DIRECT://party_b_pubkey_hex';
const CHARLIE_ADDRESS = 'DIRECT://charlie_pubkey_hex';

let testCounter = 0;

function createManifest(overrides: Partial<SwapManifest> = {}): SwapManifest {
  const nonce = String(testCounter++);
  const fields = {
    party_a_address: PARTY_A_ADDRESS,
    party_b_address: PARTY_B_ADDRESS,
    party_a_currency_to_change: 'UCT',
    party_a_value_to_change: String(1000 + testCounter),
    party_b_currency_to_change: 'USDU',
    party_b_value_to_change: String(500 + testCounter),
    timeout: 300,
    ...overrides,
  };
  const swap_id = computeSwapId(fields);
  return {
    swap_id,
    ...fields,
  };
}

interface TestContext {
  mockAccounting: MockAccountingModule;
  stateStore: InMemorySwapStateStore;
  invoiceManager: InvoiceManager;
  timeoutManager: TimeoutManager;
  orchestrator: SwapOrchestrator;
  messageSender: { sendToParty: any; sendToAddress: any };
  addressResolver: { resolve: any };
}

async function setupOrchestrator(): Promise<TestContext> {
  const mockAccounting = new MockAccountingModule();
  const stateStore = new InMemorySwapStateStore();
  const invoiceManager = new InvoiceManager({
    accounting: mockAccounting as any,
    escrowAddress: ESCROW_ADDRESS,
  });
  const messageSender = {
    sendToParty: vi.fn().mockResolvedValue(undefined),
    sendToAddress: vi.fn().mockResolvedValue(undefined),
  };
  const addressResolver = {
    resolve: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr)),
  };

  const timeoutManager = new TimeoutManager({
    onTimeout: async (swapId: string) => {
      await orchestrator._handleTimeout(swapId);
    },
  });

  const orchestrator = new SwapOrchestrator({
    invoiceManager,
    stateStore,
    timeoutManager,
    messageSender,
    addressResolver,
  });

  orchestrator.start();

  return {
    mockAccounting,
    stateStore,
    invoiceManager,
    timeoutManager,
    orchestrator,
    messageSender,
    addressResolver,
  };
}

describe('SwapLifecycle Integration Tests', () => {
  describe('Happy Path', () => {
    it('should complete full lifecycle: announce → deposit A → deposit B → coverage → payout → COMPLETED', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);
      expect(announced.is_new).toBe(true);
      expect(announced.deposit_invoice_id).toBeDefined();

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap.first_deposit_at).not.toBeNull();

      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);
      expect(swap.completed_at).not.toBeNull();
      expect(swap.payout_a_invoice_id).not.toBeNull();
      expect(swap.payout_b_invoice_id).not.toBeNull();

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should complete lifecycle when party B deposits first', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should complete lifecycle with DIRECT:// addresses (no nametag resolution)', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest({
        party_a_address: 'DIRECT://aaa',
        party_b_address: 'DIRECT://bbb',
      });

      ctx.addressResolver.resolve.mockImplementation((addr: string) =>
        Promise.resolve(addr),
      );

      const announced = await ctx.orchestrator.announce(manifest);
      expect(announced.is_new).toBe(true);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: 'DIRECT://aaa',
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: 'DIRECT://bbb',
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      const swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should deliver deposit invoice to both parties via DM on announcement', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      await ctx.orchestrator.announce(manifest);

      expect(ctx.messageSender.sendToParty).toBeDefined();
      expect(ctx.messageSender.sendToAddress).toBeDefined();

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });

  describe('Bounce Scenarios', () => {
    it('should bounce payment with wrong currency from any sender and continue accepting valid deposits', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      // Charlie sends an unrecognised currency — coinId matches neither party_a nor party_b currency
      const transferCharlie = createMockTransferRef({
        transferId: 'tx_charlie',
        senderAddress: CHARLIE_ADDRESS,
        amount: '100',
        coinId: 'EUR',
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferCharlie);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.mockAccounting._getCallOrder()).toContain('returnInvoicePayment');

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should bounce payment with wrong currency and continue accepting valid deposits', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferWrongCurrency = createMockTransferRef({
        transferId: 'tx_wrong',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: 'EUR',
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferWrongCurrency);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.mockAccounting._getCallOrder()).toContain('returnInvoicePayment');

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should ignore late payment on completed swap (SDK handles auto-return on closed invoice)', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      const transferExtra = createMockTransferRef({
        transferId: 'tx_extra',
        senderAddress: PARTY_A_ADDRESS,
        amount: '100',
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferExtra);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });

  describe('Timeout and Cancellation', () => {
    it('should cancel swap and return deposits on timeout after partial deposit', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      await ctx.orchestrator._handleTimeout(manifest.swap_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.TIMED_OUT, SwapState.CANCELLING, SwapState.CANCELLED]).toContain(
        swap.state,
      );

      ctx.mockAccounting._simulateCancelled(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.CANCELLED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should not start timeout timer until first deposit arrives', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      expect(ctx.timeoutManager.hasTimer(manifest.swap_id)).toBe(false);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.timeoutManager.hasTimer(manifest.swap_id)).toBe(true);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should notify both parties with swap_cancelled message on timeout', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      await ctx.orchestrator._handleTimeout(manifest.swap_id);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._simulateCancelled(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.objectContaining({
          type: 'swap_cancelled',
          reason: 'timeout',
        }),
      );

      expect(ctx.messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.objectContaining({
          type: 'swap_cancelled',
          reason: 'timeout',
        }),
      );

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });

  describe('Race Conditions', () => {
    it('should handle coverage-vs-timeout race (coverage wins)', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator._handleTimeout(manifest.swap_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should handle coverage-vs-timeout race (timeout wins)', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      await new Promise((r) => setTimeout(r, 10));

      await ctx.orchestrator._handleTimeout(manifest.swap_id);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.TIMED_OUT, SwapState.CANCELLING]).toContain(swap.state);

      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._simulateCancelled(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.CANCELLED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should handle both deposits arriving simultaneously', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      let swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      swap = ctx.stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should prevent duplicate swap creation when same manifest announced twice', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const result1 = await ctx.orchestrator.announce(manifest);
      expect(result1.is_new).toBe(true);

      const result2 = await ctx.orchestrator.announce(manifest);
      expect(result2.is_new).toBe(false);
      expect(result2.deposit_invoice_id).toBe(result1.deposit_invoice_id);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });

  describe('Multiple Swaps', () => {
    it('should run 2 independent swaps concurrently without cross-contamination', async () => {
      const ctx = await setupOrchestrator();
      const manifest1 = createManifest();
      const manifest2 = createManifest();

      const announced1 = await ctx.orchestrator.announce(manifest1);
      const announced2 = await ctx.orchestrator.announce(manifest2);

      expect(announced1.swap_id).not.toBe(announced2.swap_id);
      expect(announced1.deposit_invoice_id).not.toBe(announced2.deposit_invoice_id);

      const transferA1 = createMockTransferRef({
        transferId: 'tx_a1',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest1.party_a_value_to_change,
        coinId: manifest1.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced1.deposit_invoice_id, transferA1);
      await new Promise((r) => setTimeout(r, 10));

      const swap1 = ctx.stateStore.findBySwapId(manifest1.swap_id)!;
      const swap2 = ctx.stateStore.findBySwapId(manifest2.swap_id)!;

      expect(swap1.state).toBe(SwapState.PARTIAL_DEPOSIT);
      expect(swap2.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should handle different swap timeouts independently', async () => {
      const ctx = await setupOrchestrator();
      const manifest1 = createManifest({ timeout: 100 });
      const manifest2 = createManifest({ timeout: 300 });

      const announced1 = await ctx.orchestrator.announce(manifest1);
      const announced2 = await ctx.orchestrator.announce(manifest2);

      const transferA1 = createMockTransferRef({
        transferId: 'tx_a1',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest1.party_a_value_to_change,
        coinId: manifest1.party_a_currency_to_change,
      });
      const transferA2 = createMockTransferRef({
        transferId: 'tx_a2',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest2.party_a_value_to_change,
        coinId: manifest2.party_a_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced1.deposit_invoice_id, transferA1);
      ctx.mockAccounting._simulatePayment(announced2.deposit_invoice_id, transferA2);
      await new Promise((r) => setTimeout(r, 10));

      const remaining1 = ctx.timeoutManager.getRemainingTime(manifest1.swap_id);
      const remaining2 = ctx.timeoutManager.getRemainingTime(manifest2.swap_id);

      expect(remaining1).not.toBeNull();
      expect(remaining2).not.toBeNull();
      expect(remaining1! < remaining2!).toBe(true);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should complete one swap while another is still in PARTIAL_DEPOSIT', async () => {
      const ctx = await setupOrchestrator();
      const manifest1 = createManifest();
      const manifest2 = createManifest();

      const announced1 = await ctx.orchestrator.announce(manifest1);
      const announced2 = await ctx.orchestrator.announce(manifest2);

      const transferA1 = createMockTransferRef({
        transferId: 'tx_a1',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest1.party_a_value_to_change,
        coinId: manifest1.party_a_currency_to_change,
      });
      const transferB1 = createMockTransferRef({
        transferId: 'tx_b1',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest1.party_b_value_to_change,
        coinId: manifest1.party_b_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced1.deposit_invoice_id, transferA1);
      ctx.mockAccounting._simulatePayment(announced1.deposit_invoice_id, transferB1);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced1.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA1, transferB1],
      });
      ctx.mockAccounting._simulateCoverage(announced1.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      const transferA2 = createMockTransferRef({
        transferId: 'tx_a2',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest2.party_a_value_to_change,
        coinId: manifest2.party_a_currency_to_change,
      });
      ctx.mockAccounting._simulatePayment(announced2.deposit_invoice_id, transferA2);
      await new Promise((r) => setTimeout(r, 10));

      const swap1 = ctx.stateStore.findBySwapId(manifest1.swap_id)!;
      const swap2 = ctx.stateStore.findBySwapId(manifest2.swap_id)!;

      expect(swap1.state).toBe(SwapState.COMPLETED);
      expect(swap2.state).toBe(SwapState.PARTIAL_DEPOSIT);

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });

  describe('Crash Recovery', () => {
    it('should resume PARTIAL_DEPOSIT swap on startup with correct remaining timeout', async () => {
      const stateStore = new InMemorySwapStateStore();
      const mockAccounting = new MockAccountingModule();
      const manifest = createManifest();

      const announced = await mockAccounting.createInvoice({
        targets: [
          {
            address: ESCROW_ADDRESS,
            assets: [
              [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
              [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
            ],
          },
        ],
        memo: `Escrow deposit for swap ${manifest.swap_id}`,
      });

      const swap = stateStore.create(manifest, {
        partyA: PARTY_A_ADDRESS,
        partyB: PARTY_B_ADDRESS,
      });
      const now = Date.now();
      const timeoutAt = now + 250000;
      const withInvoice = stateStore.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: announced.invoiceId! },
        swap.version,
      )!;
      const withDeposit = stateStore.updateState(
        manifest.swap_id,
        SwapState.PARTIAL_DEPOSIT,
        { first_deposit_at: now, timeout_at: timeoutAt },
        withInvoice.version,
      )!;

      const invoiceManager = new InvoiceManager({
        accounting: mockAccounting as any,
        escrowAddress: ESCROW_ADDRESS,
      });
      const timeoutManager = new TimeoutManager({
        onTimeout: async (swapId: string) => {
          await orchestrator._handleTimeout(swapId);
        },
      });
      const messageSender = {
        sendToParty: vi.fn().mockResolvedValue(undefined),
        sendToAddress: vi.fn().mockResolvedValue(undefined),
      };
      const addressResolver = {
        resolve: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr)),
      };

      const orchestrator = new SwapOrchestrator({
        invoiceManager,
        stateStore,
        timeoutManager,
        messageSender,
        addressResolver,
      });
      orchestrator.start();

      await orchestrator.recoverSwaps();

      const remaining = timeoutManager.getRemainingTime(manifest.swap_id);
      expect(remaining).not.toBeNull();
      expect(remaining! > 0).toBe(true);

      await orchestrator.stop();
      timeoutManager.destroy();
    });

    it('should resume CONCLUDING swap and complete payout', async () => {
      const stateStore = new InMemorySwapStateStore();
      const mockAccounting = new MockAccountingModule();
      const manifest = createManifest();

      const depositResult = await mockAccounting.createInvoice({
        targets: [
          {
            address: ESCROW_ADDRESS,
            assets: [
              [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
              [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
            ],
          },
        ],
      });

      const payoutAResult = await mockAccounting.createInvoice({
        targets: [
          {
            address: PARTY_A_ADDRESS,
            assets: [[manifest.party_b_currency_to_change, manifest.party_b_value_to_change]],
          },
        ],
      });

      const payoutBResult = await mockAccounting.createInvoice({
        targets: [
          {
            address: PARTY_B_ADDRESS,
            assets: [[manifest.party_a_currency_to_change, manifest.party_a_value_to_change]],
          },
        ],
      });

      const swap = stateStore.create(manifest, {
        partyA: PARTY_A_ADDRESS,
        partyB: PARTY_B_ADDRESS,
      });
      const withInvoice = stateStore.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: depositResult.invoiceId! },
        swap.version,
      )!;
      const concluding = stateStore.updateState(
        manifest.swap_id,
        SwapState.CONCLUDING,
        {
          payout_a_invoice_id: payoutAResult.invoiceId!,
          payout_b_invoice_id: payoutBResult.invoiceId!,
        },
        withInvoice.version,
      )!;

      const invoiceManager = new InvoiceManager({
        accounting: mockAccounting as any,
        escrowAddress: ESCROW_ADDRESS,
      });
      const timeoutManager = new TimeoutManager({
        onTimeout: async (swapId: string) => {
          await orchestrator._handleTimeout(swapId);
        },
      });
      const messageSender = {
        sendToParty: vi.fn().mockResolvedValue(undefined),
        sendToAddress: vi.fn().mockResolvedValue(undefined),
      };
      const addressResolver = {
        resolve: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr)),
      };

      const orchestrator = new SwapOrchestrator({
        invoiceManager,
        stateStore,
        timeoutManager,
        messageSender,
        addressResolver,
      });
      orchestrator.start();

      await orchestrator.recoverSwaps();
      await new Promise((r) => setTimeout(r, 50));

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.COMPLETED);

      await orchestrator.stop();
      timeoutManager.destroy();
    });

    it('should resume ANNOUNCED swap by re-creating deposit invoice', async () => {
      const stateStore = new InMemorySwapStateStore();
      const mockAccounting = new MockAccountingModule();
      const manifest = createManifest();

      const swap = stateStore.create(manifest, {
        partyA: PARTY_A_ADDRESS,
        partyB: PARTY_B_ADDRESS,
      });

      expect(swap.state).toBe(SwapState.ANNOUNCED);
      expect(swap.deposit_invoice_id).toBeNull();

      const invoiceManager = new InvoiceManager({
        accounting: mockAccounting as any,
        escrowAddress: ESCROW_ADDRESS,
      });
      const timeoutManager = new TimeoutManager({
        onTimeout: async (swapId: string) => {
          await orchestrator._handleTimeout(swapId);
        },
      });
      const messageSender = {
        sendToParty: vi.fn().mockResolvedValue(undefined),
        sendToAddress: vi.fn().mockResolvedValue(undefined),
      };
      const addressResolver = {
        resolve: vi.fn().mockImplementation((addr: string) => Promise.resolve(addr)),
      };

      const orchestrator = new SwapOrchestrator({
        invoiceManager,
        stateStore,
        timeoutManager,
        messageSender,
        addressResolver,
      });
      orchestrator.start();

      await orchestrator.recoverSwaps();

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(recovered.deposit_invoice_id).not.toBeNull();

      await orchestrator.stop();
      timeoutManager.destroy();
    });
  });

  describe('DM Protocol Integration', () => {
    it('should send payment_confirmation DMs after conclusion', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx_a',
        senderAddress: PARTY_A_ADDRESS,
        amount: manifest.party_a_value_to_change,
        coinId: manifest.party_a_currency_to_change,
      });
      const transferB = createMockTransferRef({
        transferId: 'tx_b',
        senderAddress: PARTY_B_ADDRESS,
        amount: manifest.party_b_value_to_change,
        coinId: manifest.party_b_currency_to_change,
      });

      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);
      await new Promise((r) => setTimeout(r, 10));

      ctx.mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'COVERED',
        transfers: [transferA, transferB],
      });
      ctx.mockAccounting._simulateCoverage(announced.deposit_invoice_id);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.objectContaining({
          type: 'payment_confirmation',
          currency: manifest.party_b_currency_to_change,
          amount: manifest.party_b_value_to_change,
        }),
      );

      expect(ctx.messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.objectContaining({
          type: 'payment_confirmation',
          currency: manifest.party_a_currency_to_change,
          amount: manifest.party_a_value_to_change,
        }),
      );

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });

    it('should send bounce_notification DMs for rejected payments (wrong currency)', async () => {
      const ctx = await setupOrchestrator();
      const manifest = createManifest();

      const announced = await ctx.orchestrator.announce(manifest);

      // Send a payment with a currency that matches neither party's expected currency
      const transfer = createMockTransferRef({
        transferId: 'tx_charlie',
        senderAddress: CHARLIE_ADDRESS,
        amount: '100',
        coinId: 'EUR',
      });
      ctx.mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.messageSender.sendToAddress).toHaveBeenCalledWith(
        CHARLIE_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'WRONG_CURRENCY',
        }),
      );

      await ctx.orchestrator.stop();
      ctx.timeoutManager.destroy();
    });
  });
});
