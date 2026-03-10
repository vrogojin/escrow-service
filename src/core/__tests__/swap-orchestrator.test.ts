import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SwapOrchestrator } from '../swap-orchestrator.js';
import { InvoiceManager } from '../invoice-manager.js';
import { TimeoutManager } from '../timeout-manager.js';
import { SwapState } from '../state-machine.js';
import { computeSwapId } from '../../utils/hash.js';
import { MockAccountingModule } from '../../__tests__/helpers/mock-accounting-module.js';
import { InMemorySwapStateStore } from '../../__tests__/helpers/in-memory-swap-state-store.js';
import { createMockTransferRef } from '../../__tests__/helpers/mock-invoice-status.js';
import type { SwapManifest } from '../manifest-validator.js';

const PARTY_A_ADDRESS = 'DIRECT://0xaaaaaa';
const PARTY_B_ADDRESS = 'DIRECT://0xbbbbbb';
const CHARLIE_ADDRESS = 'DIRECT://0xcccccc';
const ESCROW_ADDRESS = 'DIRECT://0xescrow';

let testCounter = 0;
function createTestManifest(): SwapManifest {
  const nonce = String(testCounter++);
  const fields = {
    party_a_address: PARTY_A_ADDRESS,
    party_b_address: PARTY_B_ADDRESS,
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: String(1000000 + testCounter),
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '850000',
    timeout: 300,
  };
  const swap_id = computeSwapId(fields);
  return {
    swap_id,
    ...fields,
  };
}

async function setupOrchestrator() {
  const mockAccounting = new MockAccountingModule();
  const invoiceManager = new InvoiceManager({ accounting: mockAccounting as any, escrowAddress: ESCROW_ADDRESS });
  const stateStore = new InMemorySwapStateStore();
  const timeoutManager = new TimeoutManager({ onTimeout: async (swapId) => orchestrator._handleTimeout(swapId) });
  const messageSender = {
    sendToParty: vi.fn().mockResolvedValue(undefined),
    sendToAddress: vi.fn().mockResolvedValue(undefined)
  };
  const addressResolver = {
    resolve: vi.fn().mockImplementation((addr) => Promise.resolve(addr))
  };
  const orchestrator = new SwapOrchestrator({ invoiceManager, stateStore, timeoutManager, messageSender, addressResolver });
  orchestrator.start();

  return { orchestrator, mockAccounting, stateStore, invoiceManager, messageSender, addressResolver, timeoutManager };
}

describe('SwapOrchestrator', () => {
  describe('invoice:payment Event Handling', () => {
    it('should transition DEPOSIT_INVOICE_CREATED → PARTIAL_DEPOSIT on first valid deposit', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      expect(announced.is_new).toBe(true);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      const swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap).not.toBeNull();
      expect(swap!.state).toBe(SwapState.PARTIAL_DEPOSIT);
    });

    it('should start timeout timer on first valid deposit', async () => {
      const { orchestrator, mockAccounting, stateStore, timeoutManager } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(true);
    });

    it('should NOT start timeout timer on second valid deposit (already running)', async () => {
      const { orchestrator, mockAccounting, timeoutManager } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      await new Promise((r) => setTimeout(r, 10));

      const remainingBefore = timeoutManager.getRemainingTime(manifest.swap_id);
      expect(remainingBefore).not.toBeNull();
      expect(remainingBefore! > 0).toBe(true);

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);
      await new Promise((r) => setTimeout(r, 10));

      const remainingAfter = timeoutManager.getRemainingTime(manifest.swap_id);
      expect(Math.abs((remainingBefore ?? 0) - (remainingAfter ?? 0))).toBeLessThan(50);
    });

    it('should bounce payment from unknown sender (call returnPayment)', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).toContain('returnInvoicePayment');
      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        CHARLIE_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'UNKNOWN_SENDER',
        }),
      );
    });

    it('should bounce payment when sender paid wrong currency', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).toContain('returnInvoicePayment');
      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        PARTY_A_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'WRONG_CURRENCY',
        }),
      );
    });

    it('should use effectiveSender as recipient for returnPayment (not senderAddress)', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        refundAddress: 'DIRECT://0xrefund',
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      const invoiceState = mockAccounting._getInvoiceState(announced.deposit_invoice_id);
      const transfers = invoiceState?.transfers ?? [];
      expect(transfers.length).toBe(1);
    });

    it('should bounce payment with senderAddress === null (masked predicate)', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: null,
        refundAddress: 'DIRECT://0xrefund',
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).toContain('returnInvoicePayment');
    });

    it('should ignore payment event when swap is in TIMED_OUT state', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.TIMED_OUT, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');
    });

    it('should bounce payment from charlie even when charlie refundAddress spoofs party A DIRECT address', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        refundAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).toContain('returnInvoicePayment');
    });

    it('should not transition to DEPOSIT_COVERED within payment handler (that is invoice:covered job)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).not.toBe(SwapState.DEPOSIT_COVERED);
    });
  });

  describe('invoice:covered Event Handling', () => {
    it('should transition to DEPOSIT_COVERED on coverage', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(swap.state);
    });

    it('should re-validate per-party coverage using transfers senderAddress', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transferA = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transferB = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transferA);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transferB);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(swap.state);
    });

    it('should cancel timeout timer on coverage', async () => {
      const { orchestrator, mockAccounting, timeoutManager } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      await new Promise((r) => setTimeout(r, 10));

      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(true);

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(false);
    });

    it('should call closeDepositInvoice() without autoReturn', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      expect(mockAccounting._getCallOrder()).toContain('closeInvoice');
    });

    it('should create two payout invoices with correct cross-currency targets', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const createInvoiceCalls = mockAccounting._getCallOrder().filter((c) => c === 'createInvoice');
      expect(createInvoiceCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('should NOT transpose payouts (party A gets party B currency, not their own)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.payout_a_invoice_id).not.toBeNull();
      expect(swap.payout_b_invoice_id).not.toBeNull();
    });

    it('should persist CONCLUDING with payout IDs BEFORE payInvoice()', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const callOrder = mockAccounting._getCallOrder();
      const closeIdx = callOrder.indexOf('closeInvoice');
      const payIdx = callOrder.lastIndexOf('payInvoice');
      expect(closeIdx).toBeGreaterThanOrEqual(0);
      expect(payIdx).toBeGreaterThan(closeIdx);
    });

    it('should call payInvoice() for both payout invoices', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const payInvoiceCalls = mockAccounting._getCallOrder().filter((c) => c === 'payInvoice');
      expect(payInvoiceCalls.length).toBe(2);
    });

    it('should transition CONCLUDING → COMPLETED after payouts succeed', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);
      expect(swap.completed_at).not.toBeNull();
    });

    it('should send payment_confirmation DMs after payouts', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.objectContaining({
          type: 'payment_confirmation',
        }),
      );

      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.objectContaining({
          type: 'payment_confirmation',
        }),
      );
    });

    it('should reject coverage from impersonator (charlie with correct amount but wrong senderAddress)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: CHARLIE_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).not.toBe(SwapState.DEPOSIT_COVERED);
    });

    it('should handle INVOICE_ALREADY_CLOSED gracefully (proceed)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, { isClosed: true });

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.COMPLETED);
    });
  });

  describe('invoice:cancelled Event', () => {
    it('should transition CANCELLING → CANCELLED', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.TIMED_OUT, {}, swap.version);

      const timedOut = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.CANCELLING, {}, timedOut.version);

      await orchestrator._onInvoiceCancelled({ invoiceId: announced.deposit_invoice_id });

      const cancelled = stateStore.findBySwapId(manifest.swap_id)!;
      expect(cancelled.state).toBe(SwapState.CANCELLED);
    });

    it('should ignore if swap not in CANCELLING state', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).not.toBe(SwapState.CANCELLING);

      await orchestrator._onInvoiceCancelled({ invoiceId: announced.deposit_invoice_id });

      const unchanged = stateStore.findBySwapId(manifest.swap_id)!;
      expect(unchanged.state).not.toBe(SwapState.CANCELLED);
    });

    it('should notify both parties with swap_cancelled message', async () => {
      const { orchestrator, stateStore, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.TIMED_OUT, {}, swap.version);

      const timedOut = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.CANCELLING, {}, timedOut.version);

      await orchestrator._onInvoiceCancelled({ invoiceId: announced.deposit_invoice_id });

      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.objectContaining({
          type: 'swap_cancelled',
        }),
      );

      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.objectContaining({
          type: 'swap_cancelled',
        }),
      );
    });
  });

  describe('Timeout handling', () => {
    it('should transition to TIMED_OUT and cancel invoice on timeout', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      await orchestrator._handleTimeout(manifest.swap_id);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.TIMED_OUT, SwapState.CANCELLING, SwapState.CANCELLED]).toContain(swap.state);
    });

    it('should persist TIMED_OUT BEFORE calling cancelInvoice (persist-before-act)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      await orchestrator._handleTimeout(manifest.swap_id);

      const callOrder = mockAccounting._getCallOrder();
      const cancelIdx = callOrder.indexOf('cancelInvoice');
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
    });

    it('should ignore timeout if swap already DEPOSIT_COVERED', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.DEPOSIT_COVERED, {}, swap.version);

      await orchestrator._handleTimeout(manifest.swap_id);

      const covered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(covered.state).toBe(SwapState.DEPOSIT_COVERED);
    });
  });

  describe('Announce', () => {
    it('should create swap and deposit invoice', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const result = await orchestrator.announce(manifest);

      expect(result.is_new).toBe(true);
      expect(result.deposit_invoice_id).toBeDefined();
      expect(result.swap_id).toBe(manifest.swap_id);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap).not.toBeNull();
      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
    });

    it('should return existing swap (is_new: false)', async () => {
      const { orchestrator } = await setupOrchestrator();
      const manifest = createTestManifest();

      const result1 = await orchestrator.announce(manifest);
      const result2 = await orchestrator.announce(manifest);

      expect(result1.is_new).toBe(true);
      expect(result2.is_new).toBe(false);
      expect(result1.deposit_invoice_id).toBe(result2.deposit_invoice_id);
    });

    it('should re-attempt invoice creation for ANNOUNCED swap (retry flow)', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.ANNOUNCED, { deposit_invoice_id: null }, swap.version);

      const result = await orchestrator.announce(manifest);

      expect(result.is_new).toBe(true);
      expect(result.deposit_invoice_id).toBeDefined();
    });
  });
});
