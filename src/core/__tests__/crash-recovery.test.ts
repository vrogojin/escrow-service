import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockAccountingModule } from '../../__tests__/helpers/mock-accounting-module.js';
import { InMemorySwapStateStore } from '../../__tests__/helpers/in-memory-swap-state-store.js';
import { createMockTransferRef } from '../../__tests__/helpers/mock-invoice-status.js';
import { InvoiceManager } from '../invoice-manager.js';
import { TimeoutManager } from '../timeout-manager.js';
import { SwapOrchestrator } from '../swap-orchestrator.js';
import { CrashRecoveryManager } from '../crash-recovery-manager.js';
import { SwapState } from '../state-machine.js';
import { computeSwapId } from '../../utils/hash.js';
import type { SwapManifest } from '../manifest-validator.js';

const PARTY_A_ADDRESS = 'DIRECT://0xaaaaaa';
const PARTY_B_ADDRESS = 'DIRECT://0xbbbbbb';
const ESCROW_ADDRESS = 'DIRECT://escrow';

let testCounter = 0;
function createTestManifest(): SwapManifest {
  const nonce = String(testCounter++);
  const fields = {
    party_a_address: PARTY_A_ADDRESS,
    party_b_address: PARTY_B_ADDRESS,
    party_a_currency_to_change: 'UCT',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'USDU',
    party_b_value_to_change: '500',
    timeout: 600,
  };
  const swap_id = computeSwapId(fields);
  return { swap_id, ...fields };
}

async function setupOrchestrator() {
  const mockAccounting = new MockAccountingModule();
  const invoiceManager = new InvoiceManager({ accounting: mockAccounting as any, escrowAddress: ESCROW_ADDRESS });
  const stateStore = new InMemorySwapStateStore();

  let handleTimeoutFn: ((swapId: string) => Promise<void>) | null = null;
  const timeoutManager = new TimeoutManager({
    onTimeout: async (swapId) => {
      if (handleTimeoutFn) {
        return handleTimeoutFn(swapId);
      }
    },
  });

  const messageSender = {
    sendToParty: vi.fn().mockResolvedValue(undefined),
    sendToAddress: vi.fn().mockResolvedValue(undefined),
  };

  const addressResolver = {
    resolve: vi.fn().mockImplementation((addr) => Promise.resolve(addr)),
  };

  const orchestrator = new SwapOrchestrator({
    stateStore,
    invoiceManager,
    timeoutManager,
    messageSender,
    addressResolver,
  });

  handleTimeoutFn = (swapId: string) => (orchestrator as any)._handleTimeout(swapId);
  orchestrator.start();

  const recoveryManager = new CrashRecoveryManager({
    invoiceManager,
    stateStore,
    timeoutManager,
    orchestrator,
  });

  return { orchestrator, recoveryManager, mockAccounting, stateStore, invoiceManager, messageSender, addressResolver, timeoutManager };
}

describe('CrashRecoveryManager', () => {
  describe('ANNOUNCED Recovery', () => {
    it('should re-create deposit invoice when swap is ANNOUNCED', async () => {
      const { orchestrator, recoveryManager, stateStore } = await setupOrchestrator();
      const manifest = createTestManifest();

      // Create a new swap in ANNOUNCED state
      const announced = await orchestrator.announce(manifest);
      expect(announced.is_new).toBe(true);

      // Get the current swap (should be in DEPOSIT_INVOICE_CREATED)
      let swap = stateStore.findBySwapId(manifest.swap_id);
      expect(swap).not.toBeNull();
      expect(swap!.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      // Move it back to ANNOUNCED to simulate a crash between state save and invoice creation
      const reverted = stateStore.updateState(
        swap!.swap_id,
        SwapState.ANNOUNCED,
        { deposit_invoice_id: null },
        swap!.version
      );
      expect(reverted).not.toBeNull();

      // Now recover it
      const announcedSwap = stateStore.findBySwapId(manifest.swap_id);
      expect(announcedSwap!.state).toBe(SwapState.ANNOUNCED);

      await recoveryManager.recoverSwap(announcedSwap!);

      // After recovery, should be back in DEPOSIT_INVOICE_CREATED
      const recovered = stateStore.findBySwapId(manifest.swap_id);
      expect(recovered!.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(recovered!.deposit_invoice_id).not.toBeNull();
    });
  });

  describe('DEPOSIT_INVOICE_CREATED Recovery', () => {
    it('should wait for deposits when invoice is OPEN', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      const swap = stateStore.findBySwapId(manifest.swap_id)!;

      expect(swap.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);

      // Keep invoice in OPEN state
      mockAccounting._setInvoiceState(swap.deposit_invoice_id!, {
        state: 'OPEN',
        terms: {
          targets: [
            {
              address: ESCROW_ADDRESS,
              assets: [
                [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
                [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
              ],
            },
          ],
        },
      });

      // Recovery should maintain the state since no deposits yet
      await recoveryManager.recoverSwap(swap);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
    });

    it('should transition to CANCELLED when invoice is CANCELLED', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      const swap = stateStore.findBySwapId(manifest.swap_id)!;

      // Set invoice to CANCELLED - must set all required state including terms
      mockAccounting._setInvoiceState(swap.deposit_invoice_id!, {
        state: 'CANCELLED',
        isCancelled: true,
        terms: {
          targets: [
            {
              address: ESCROW_ADDRESS,
              assets: [
                [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
                [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
              ],
            },
          ],
        },
      });

      await recoveryManager.recoverSwap(swap);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.CANCELLED);
    });
  });

  describe('PARTIAL_DEPOSIT Recovery', () => {
    it('should re-register timeout when invoice is PARTIAL', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting, timeoutManager } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Simulate a deposit
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000',
        coinId: 'UCT',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      await new Promise((r) => setTimeout(r, 20));

      // Get the swap in PARTIAL_DEPOSIT state
      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Verify timeout was registered
      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(true);

      // Clear the timer to simulate a crash
      timeoutManager.cancel(manifest.swap_id);
      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(false);

      // Keep invoice in PARTIAL state with proper terms
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'PARTIAL',
        terms: {
          targets: [
            {
              address: ESCROW_ADDRESS,
              assets: [
                [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
                [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
              ],
            },
          ],
        },
      });

      // Recovery should re-register timeout
      const reRegisterSpy = vi.spyOn(timeoutManager, 'reRegister');
      await recoveryManager.recoverSwap(swap);

      expect(reRegisterSpy).toHaveBeenCalled();
      expect(timeoutManager.hasTimer(manifest.swap_id)).toBe(true);
    });

    it('should transition to CANCELLED when invoice is CANCELLED', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);

      // Simulate a deposit to move to PARTIAL_DEPOSIT
      const transfer = createMockTransferRef({
        transferId: 'tx1',
        senderAddress: PARTY_A_ADDRESS,
        amount: '1000',
        coinId: 'UCT',
      });

      mockAccounting._simulatePayment(announced.deposit_invoice_id, transfer);
      await new Promise((r) => setTimeout(r, 20));

      const swap = stateStore.findBySwapId(manifest.swap_id)!;
      expect(swap.state).toBe(SwapState.PARTIAL_DEPOSIT);

      // Set invoice to CANCELLED with proper terms
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'CANCELLED',
        isCancelled: true,
        terms: {
          targets: [
            {
              address: ESCROW_ADDRESS,
              assets: [
                [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
                [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
              ],
            },
          ],
        },
      });

      await recoveryManager.recoverSwap(swap);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.CANCELLED);
    });
  });

  describe('TIMED_OUT Recovery', () => {
    it('should cancel invoice when TIMED_OUT and invoice OPEN', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      let swap = stateStore.findBySwapId(manifest.swap_id)!;

      // Move to TIMED_OUT state
      const timedOut = stateStore.updateState(
        swap.swap_id,
        SwapState.TIMED_OUT,
        {},
        swap.version
      );
      expect(timedOut).not.toBeNull();

      // Keep invoice OPEN
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, { state: 'OPEN' });

      await recoveryManager.recoverSwap(timedOut!);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.CANCELLING);
    });

    it('should transition directly to CANCELLED when invoice already CANCELLED', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      let swap = stateStore.findBySwapId(manifest.swap_id)!;

      // Move to TIMED_OUT state
      const timedOut = stateStore.updateState(
        swap.swap_id,
        SwapState.TIMED_OUT,
        {},
        swap.version
      );
      expect(timedOut).not.toBeNull();

      // Set invoice to CANCELLED
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, { state: 'CANCELLED', isCancelled: true });

      await recoveryManager.recoverSwap(timedOut!);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.CANCELLED);
    });
  });

  describe('CANCELLING Recovery', () => {
    it('should transition to CANCELLED when invoice already CANCELLED', async () => {
      const { orchestrator, recoveryManager, stateStore, mockAccounting } = await setupOrchestrator();
      const manifest = createTestManifest();

      const announced = await orchestrator.announce(manifest);
      let swap = stateStore.findBySwapId(manifest.swap_id)!;

      // Move to CANCELLING state
      const cancelling = stateStore.updateState(
        swap.swap_id,
        SwapState.CANCELLING,
        {},
        swap.version
      );
      expect(cancelling).not.toBeNull();

      // Set invoice to CANCELLED with proper terms
      mockAccounting._setInvoiceState(announced.deposit_invoice_id, {
        state: 'CANCELLED',
        isCancelled: true,
        terms: {
          targets: [
            {
              address: ESCROW_ADDRESS,
              assets: [
                [manifest.party_a_currency_to_change, manifest.party_a_value_to_change],
                [manifest.party_b_currency_to_change, manifest.party_b_value_to_change],
              ],
            },
          ],
        },
      });

      await recoveryManager.recoverSwap(cancelling!);

      const recovered = stateStore.findBySwapId(manifest.swap_id)!;
      expect(recovered.state).toBe(SwapState.CANCELLED);
    });
  });
});
