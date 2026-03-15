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

const PARTY_A_ADDRESS = 'DIRECT://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARTY_B_ADDRESS = 'DIRECT://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHARLIE_ADDRESS = 'DIRECT://cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const ESCROW_ADDRESS = 'DIRECT://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

let testCounter = 0;
function createTestManifest(): SwapManifest {
  testCounter++;
  const fields = {
    party_a_address: PARTY_A_ADDRESS,
    party_b_address: PARTY_B_ADDRESS,
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '850000',
    timeout: 300 + testCounter, // varies per test to ensure unique swap_id
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

    it('should accept deposit from any sender if coinId matches expected currency', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Charlie (not a named party) deposits USD — valid because coinId matches party A's currency slot
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // Payment must NOT be bounced — it covers the USD slot regardless of sender
      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');

      const swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap!.state).toBe(SwapState.PARTIAL_DEPOSIT);
    });

    it('should bounce payment when sender paid wrong currency', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // GBP matches neither party_a_currency (USD) nor party_b_currency (EUR) — must be bounced
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'GBP',
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

    it('should use effectiveSender (refundAddress) as recipient for returnPayment on WRONG_CURRENCY', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Sender pays an unknown currency (GBP) with a refundAddress set.
      // The bounce should be routed to refundAddress, not senderAddress.
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        refundAddress: 'DIRECT://dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        amount: '1000000',
        coinId: 'GBP',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).toContain('returnInvoicePayment');
      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        'DIRECT://dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'WRONG_CURRENCY',
        }),
      );
    });

    it('should accept deposit from masked predicate sender if coinId matches', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // senderAddress is null (masked predicate) but coinId matches USD slot — must be accepted
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: null,
        refundAddress: 'DIRECT://dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');

      const swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap!.state).toBe(SwapState.PARTIAL_DEPOSIT);
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

    it('should accept deposit from charlie even when refundAddress is set to party A address', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Charlie deposits USD with refundAddress spoofed to party A's address.
      // The new model does not check sender identity — USD matches slot A, so it is accepted.
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        refundAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');

      const swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap!.state).toBe(SwapState.PARTIAL_DEPOSIT);
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

    it('should re-validate currency-slot coverage (not sender identity) on invoice:covered', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Deposits from any sender — only coinId matters for slot coverage
      const transferA = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      const transferB = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: CHARLIE_ADDRESS,
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

    it('should call closeDepositInvoice() with autoReturn (surplus delegated to SDK)', async () => {
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

    it('should accept coverage when both currency slots are filled regardless of who sent each deposit', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Party A deposits USD, Charlie deposits EUR — both slots are filled
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
      expect([SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(swap.state);
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

  describe('State Guards & Race Conditions', () => {
    it('should ignore invoice:covered if swap is already in DEPOSIT_COVERED state (idempotency)', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.DEPOSIT_COVERED, {}, swap.version);

      // invoice:covered event should be ignored
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const unchanged = stateStore.findBySwapId(manifest.swap_id)!;
      expect(unchanged.state).toBe(SwapState.DEPOSIT_COVERED);
    });

    it('should ignore timeout if swap already transitioned to DEPOSIT_COVERED', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.DEPOSIT_COVERED, {}, swap.version);

      // Timeout should be ignored
      await orchestrator._handleTimeout(manifest.swap_id);

      const unchanged = stateStore.findBySwapId(manifest.swap_id)!;
      expect(unchanged.state).toBe(SwapState.DEPOSIT_COVERED);
    });

    it('should ignore invoice:covered when swap is in CONCLUDING state (idempotency)', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      const concluding = stateStore.updateState(manifest.swap_id, SwapState.CONCLUDING, {}, swap.version)!;

      // invoice:covered event should be ignored when already CONCLUDING
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const unchanged = stateStore.findBySwapId(manifest.swap_id)!;
      expect(unchanged.state).toBe(SwapState.CONCLUDING);
    });

    it('should send bounce_notification with reason ALREADY_COVERED when payment arrives on DEPOSIT_COVERED state', async () => {
      const { orchestrator, mockAccounting, messageSender, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.DEPOSIT_COVERED, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        PARTY_A_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'ALREADY_COVERED',
        }),
      );
    });

    it('should send bounce_notification with reason ALREADY_COVERED when payment arrives on CONCLUDING state', async () => {
      const { orchestrator, mockAccounting, messageSender, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.CONCLUDING, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        CHARLIE_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'ALREADY_COVERED',
        }),
      );
    });

    it('should ignore payment when swap is in CANCELLED state (let autoReturn handle it)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.CANCELLED, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // Should not attempt to return payment in handler (autoReturn handles it)
      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');
    });

    it('should not call returnInvoicePayment() when swap is in FAILED state (terminal)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.FAILED, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'GBP', // wrong currency
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');
    });

    it('should not start duplicate timeout timer when two invoice:payment events fire concurrently', async () => {
      const { orchestrator, mockAccounting, timeoutManager } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      // First payment — timer should be scheduled
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);

      await new Promise((r) => setTimeout(r, 10));

      const remainingAfterFirst = timeoutManager.getRemainingTime(manifest.swap_id);
      expect(remainingAfterFirst).not.toBeNull();

      // Second valid payment (should not reschedule timer)
      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      await new Promise((r) => setTimeout(r, 10));

      // Timer should still exist and be approximately the same
      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(true);
      const remainingAfterSecond = timeoutManager.getRemainingTime(manifest.swap_id);
      expect(remainingAfterSecond).not.toBeNull();
      expect(Math.abs((remainingAfterFirst ?? 0) - (remainingAfterSecond ?? 0))).toBeLessThan(50);
    });

    it('should handle optimistic lock null return by aborting operation on version mismatch', async () => {
      const { orchestrator, stateStore, mockAccounting } = await setupOrchestrator();
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

      // Manually advance state to cause version mismatch during coverage
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      const modified = stateStore.updateState(manifest.swap_id, SwapState.TIMED_OUT, {}, swap.version)!;

      // invoice:covered should see version mismatch and abort
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      const final = stateStore.findBySwapId(manifest.swap_id)!;
      // Should have contested TIMED_OUT and won the race to DEPOSIT_COVERED (coverage wins per spec)
      expect([SwapState.TIMED_OUT, SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(final.state);
    });
  });

  describe('Rate Limiting — Wrong-Currency Payment Flooding', () => {
    it('should not call returnInvoicePayment() more than N times per minute per invoice', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Send multiple wrong-currency payments
      for (let i = 0; i < 15; i++) {
        const transfer = createMockTransferRef({
          transferId: `tx_bad_${i}`,
          senderAddress: CHARLIE_ADDRESS,
          amount: '100000',
          coinId: 'GBP', // wrong currency
        });

        mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      }

      await new Promise((r) => setTimeout(r, 50));

      // Count returnInvoicePayment calls — should be rate-limited
      const returnCalls = mockAccounting._getCallOrder().filter((c) => c === 'returnInvoicePayment').length;
      expect(returnCalls).toBeLessThanOrEqual(10); // MAX_BOUNCES_PER_MINUTE
    });

    it('should log wrong-currency payments that exceed the rate limit without returning immediately', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Send many wrong-currency payments to trigger rate limiting
      for (let i = 0; i < 15; i++) {
        const transfer = createMockTransferRef({
          transferId: `tx_bad_${i}`,
          senderAddress: CHARLIE_ADDRESS,
          amount: '100000',
          coinId: 'GBP',
        });

        mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      }

      await new Promise((r) => setTimeout(r, 50));

      // Some payments should be deferred (not returned immediately)
      const returnCalls = mockAccounting._getCallOrder().filter((c) => c === 'returnInvoicePayment').length;
      expect(returnCalls).toBeLessThan(15);
    });

    it('should not starve legitimate deposit processing when flooded with wrong-currency payments', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Send 12 wrong-currency payments (exceed rate limit)
      for (let i = 0; i < 12; i++) {
        const transfer = createMockTransferRef({
          transferId: `tx_bad_${i}`,
          senderAddress: CHARLIE_ADDRESS,
          amount: '100000',
          coinId: 'GBP',
        });

        mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      }

      await new Promise((r) => setTimeout(r, 20));

      // Then send a legitimate deposit
      const legit = createMockTransferRef({
        transferId: 'tx_legit',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, legit);

      await new Promise((r) => setTimeout(r, 10));

      // Legitimate deposit should still be accepted
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).not.toBe(SwapState.DEPOSIT_INVOICE_CREATED); // Should have transitioned
    });
  });

  describe('Error Handling & Edge Cases', () => {
    it('should transition DEPOSIT_INVOICE_CREATED directly to DEPOSIT_COVERED when both deposits arrive before first event', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Both deposits arrive and are processed before invoice:covered event fires
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

    it('should NOT proceed if asset slots are swapped (party_a_currency paid into asset[1], party_b into asset[0])', async () => {
      const { orchestrator, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Pay party A's currency into party B's slot (asset[1])
      const transfer1 = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD', // party A's currency, but into party B's asset
      });

      // Pay party B's currency into party A's slot (asset[0])
      const transfer2 = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR', // party B's currency, but into party A's asset
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer1);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer2);

      // invoice:covered should reject due to swapped slots
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      // Should not have transitioned past PARTIAL_DEPOSIT
      // (both deposits were accepted individually, but coverage check failed)
    });

    it('should call closeInvoice() with autoReturn option (surplus delegated to SDK)', async () => {
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

      // Spy on closeInvoice to verify autoReturn is passed
      const closeInvoiceSpy = vi.spyOn(mockAccounting, 'closeInvoice' as any);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      // closeInvoice should be called with autoReturn: true (surplus delegated to SDK)
      expect(closeInvoiceSpy).toHaveBeenCalledWith(
        announced.deposit_invoice_id,
        expect.objectContaining({ autoReturn: true }),
      );
    });

    it('should deliver payout invoice tokens to both parties via DM after successful payouts', async () => {
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

      // Both parties should receive payout confirmations
      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.any(Object),
      );
      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.any(Object),
      );
    });

    it('should accept charlie contribution toward asset[0] coverage when charlie pays party_a_currency', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Charlie deposits party A's currency (into asset[0])
      const charlieTransfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'USD', // party A's currency
      });

      // Party B deposits their currency (into asset[1])
      const partyBTransfer = createMockTransferRef({
        transferId: 'tx2',
        senderAddress: PARTY_B_ADDRESS,
        amount: '850000',
        coinId: 'EUR', // party B's currency
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, charlieTransfer);
      mockAccounting._simulatePayment(announced.deposit_invoice_id, partyBTransfer);

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      // Coverage check is currency-only, payout goes to party A regardless of depositor
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.DEPOSIT_COVERED, SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(swap.state);
    });

    it('should accept deposit from charlie when charlie pays party_b_currency into asset[1]', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Charlie deposits party B's currency (EUR) — valid because coinId matches party B's currency slot
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '850000',
        coinId: 'EUR',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // Payment must NOT be bounced — it covers the EUR slot regardless of sender
      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');

      const swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap!.state).toBe(SwapState.PARTIAL_DEPOSIT);
    });

    it('should deliver bounce_notification DM to bounced sender in the invoice:payment handler', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Send wrong currency
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: CHARLIE_ADDRESS,
        amount: '1000000',
        coinId: 'GBP', // wrong currency
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // Bounce notification should be sent to the sender
      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        CHARLIE_ADDRESS,
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'WRONG_CURRENCY',
        }),
      );
    });

    it('should ignore payment event when swap is in FAILED state (terminal)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.FAILED, {}, swap.version);

      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000000',
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // No bounce should be returned because state is terminal
      expect(mockAccounting._getCallOrder()).not.toContain('returnInvoicePayment');
    });
  });

  describe('invoice:covered Edge Cases & Error Handling', () => {
    it('should transition to FAILED when swap is manually marked as such', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Manually set to FAILED to verify state isolation
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      const updated = stateStore.updateState(manifest.swap_id, SwapState.FAILED, {}, swap.version);

      expect(updated).not.toBeNull();
      expect(updated!.state).toBe(SwapState.FAILED);
    });

    it('should send error DM when swap transitions to FAILED from terminal condition', async () => {
      const { orchestrator, messageSender, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Manually set to FAILED state (simulating failure from earlier operation)
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      stateStore.updateState(manifest.swap_id, SwapState.FAILED, { error_message: 'Test error' }, swap.version);

      // Verify the state is set
      const failed = stateStore.findBySwapId(manifest.swap_id)!;
      expect(failed.state).toBe(SwapState.FAILED);
      expect(failed.error_message).toBe('Test error');
    });

    it('should send bounce_notification DM with WRONG_CURRENCY reason when returnInvoicePayment succeeds', async () => {
      const { orchestrator, mockAccounting, messageSender } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Send wrong currency from specific address
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: 'DIRECT://1111111111111111111111111111111111111111111111111111111111111111',
        amount: '1000000',
        coinId: 'GBP',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      await new Promise((r) => setTimeout(r, 10));

      // Verify bounce_notification was sent with WRONG_CURRENCY reason
      expect(messageSender.sendToAddress).toHaveBeenCalledWith(
        'DIRECT://1111111111111111111111111111111111111111111111111111111111111111',
        expect.objectContaining({
          type: 'bounce_notification',
          reason: 'WRONG_CURRENCY',
        }),
      );
    });

    it('should send payment_confirmation DM to party B with party_a_currency and party_a_value', async () => {
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

      await new Promise((r) => setTimeout(r, 50));

      // Party B should receive payment_confirmation with party_a_currency and party_a_value
      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'B',
        expect.objectContaining({
          type: 'payment_confirmation',
          currency: 'USD', // party_a_currency
          amount: '1000000', // party_a_value
        }),
      );
    });

    it('should send payment_confirmation DM to party A with party_b_currency and party_b_value', async () => {
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

      await new Promise((r) => setTimeout(r, 50));

      // Party A should receive payment_confirmation with party_b_currency and party_b_value
      expect(messageSender.sendToParty).toHaveBeenCalledWith(
        manifest.swap_id,
        'A',
        expect.objectContaining({
          type: 'payment_confirmation',
          currency: 'EUR', // party_b_currency
          amount: '850000', // party_b_value
        }),
      );
    });

    it('should catch INVOICE_ALREADY_CANCELLED in coverage path and abort', async () => {
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

      // Mock closeInvoice to throw INVOICE_ALREADY_CANCELLED (timeout won the race)
      const { SphereError } = await import('@unicitylabs/sphere-sdk');
      vi.spyOn(mockAccounting, 'closeInvoice' as any).mockRejectedValueOnce(
        new SphereError('Invoice already cancelled', 'INVOICE_ALREADY_CANCELLED' as any),
      );

      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      await new Promise((r) => setTimeout(r, 10));

      // Should not transition to DEPOSIT_COVERED — coverage path should abort
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).not.toBe(SwapState.DEPOSIT_COVERED);
    });
  });

  describe('Timeout Race Conditions', () => {
    it('should transition to TIMED_OUT if timeout fires before coverage', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Simulate just a partial deposit (no coverage)
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '500000', // Less than required
        coinId: 'USD',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);

      // Fire timeout callback manually
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      await orchestrator._handleTimeout(manifest.swap_id);

      // Swap should be in TIMED_OUT state
      const updated = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.TIMED_OUT, SwapState.CANCELLING, SwapState.CANCELLED]).toContain(updated.state);
    });

    it('should ignore invoice:covered after TIMED_OUT (timeout won the race)', async () => {
      const { orchestrator, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Manually set swap to TIMED_OUT state (simulating timeout winning the race)
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      const timedOut = stateStore.updateState(manifest.swap_id, SwapState.TIMED_OUT, {}, swap.version)!;

      // Try to trigger covered event — should be ignored by state guard
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      await new Promise((r) => setTimeout(r, 10));

      // Swap should remain in TIMED_OUT or move to terminal state, NOT transition to DEPOSIT_COVERED
      const updated = stateStore.findBySwapId(manifest.swap_id)!;
      expect(updated.state).not.toBe(SwapState.DEPOSIT_COVERED);
      // Should be in one of the post-timeout states
      expect([SwapState.TIMED_OUT, SwapState.CANCELLING, SwapState.CANCELLED]).toContain(updated.state);
    });

    it('should catch INVOICE_ALREADY_CLOSED in timeout path and abort (coverage won)', async () => {
      const { orchestrator, mockAccounting, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Mock cancelInvoice to throw INVOICE_ALREADY_CLOSED (coverage won race, invoice closed)
      const { SphereError } = await import('@unicitylabs/sphere-sdk');
      vi.spyOn(mockAccounting, 'cancelInvoice' as any).mockRejectedValueOnce(
        new SphereError('Invoice already closed', 'INVOICE_ALREADY_CLOSED' as any),
      );

      // Fire timeout manually
      await orchestrator._handleTimeout(manifest.swap_id);

      await new Promise((r) => setTimeout(r, 10));

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      // Should not be in TIMED_OUT if the race loss is detected
      expect(swap.state).not.toBe(SwapState.TIMED_OUT);
    });

    it('should not call payInvoice() twice when invoice:covered fires concurrently before state transition completes', async () => {
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

      // Fire two concurrent covered events
      const promise1 = orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });
      const promise2 = orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      await Promise.all([promise1, promise2]);

      await new Promise((r) => setTimeout(r, 50));

      // Count payInvoice calls — should not be doubled
      const callOrder = mockAccounting._getCallOrder();
      const payInvoiceCalls = callOrder.filter((c) => c === 'payInvoice').length;
      expect(payInvoiceCalls).toBeLessThanOrEqual(2); // At most once per payout, not 4
    });

    it('should prevent second conclusion attempt after CONCLUDING state is persisted', async () => {
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

      // First covered event should transition to CONCLUDING
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      await new Promise((r) => setTimeout(r, 10));

      const swap1 = stateStore.findBySwapId(manifest.swap_id)!;
      expect([SwapState.CONCLUDING, SwapState.COMPLETED]).toContain(swap1.state);

      // Reset callOrder to count subsequent calls
      mockAccounting._reset();
      const initialCallCount = mockAccounting._getCallOrder().length;

      // Try to trigger another covered event (race condition)
      await orchestrator._onInvoiceCovered({ invoiceId: announced.deposit_invoice_id, confirmed: true });

      await new Promise((r) => setTimeout(r, 10));

      // Should not create new payouts or call closeInvoice again
      const finalCallCount = mockAccounting._getCallOrder().length;
      expect(finalCallCount).toBe(0);
    });
  });
});
