import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockAccountingModule } from '../../__tests__/helpers/mock-accounting-module.js';
import { InvoiceManager } from '../invoice-manager.js';
import type { SwapManifest } from '../manifest-validator.js';

describe('InvoiceManager', () => {
  const ESCROW_ADDRESS = 'DIRECT://escrow_address';
  let mockAccounting: MockAccountingModule;
  let invoiceManager: InvoiceManager;

  const manifest: SwapManifest = {
    swap_id: 'a'.repeat(64),
    party_a_address: 'DIRECT://party_a',
    party_b_address: 'DIRECT://party_b',
    party_a_currency_to_change: 'UCT',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'USDU',
    party_b_value_to_change: '500',
    timeout: 600,
  };

  beforeEach(() => {
    mockAccounting = new MockAccountingModule();
    invoiceManager = new InvoiceManager({
      accounting: mockAccounting as any,
      escrowAddress: ESCROW_ADDRESS,
      getToken: () => undefined,
    });
  });

  describe('createDepositInvoice()', () => {
    it('should create invoice with escrow DIRECT address as single target', async () => {
      const result = await invoiceManager.createDepositInvoice(manifest);

      expect(result.success).toBe(true);
      expect(result.invoiceId).toBeDefined();

      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);
      expect(invoiceState).toBeDefined();
      expect(invoiceState!.terms.targets).toHaveLength(1);
      expect(invoiceState!.terms.targets![0].address).toBe(ESCROW_ADDRESS);
    });

    it('should create invoice with two coin assets (party A currency at index 0, party B currency at index 1)', async () => {
      const result = await invoiceManager.createDepositInvoice(manifest);

      expect(result.success).toBe(true);
      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);

      const assets = invoiceState!.terms.targets![0].assets || [];
      expect(assets).toHaveLength(2);
      expect(assets[0]).toEqual({ coin: ['UCT', '1000'] });
      expect(assets[1]).toEqual({ coin: ['USDU', '500'] });
    });

    it('should set memo to "Escrow deposit for swap <swap_id>"', async () => {
      const result = await invoiceManager.createDepositInvoice(manifest);

      expect(result.success).toBe(true);
      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);

      expect(invoiceState!.terms.memo).toBe(`Escrow deposit for swap ${manifest.swap_id}`);
    });

    it('should set dueDate to approximately now + timeout * 1000', async () => {
      const beforeTime = Date.now();
      const result = await invoiceManager.createDepositInvoice(manifest);
      const afterTime = Date.now();

      expect(result.success).toBe(true);
      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);

      const expectedDueDate = beforeTime + manifest.timeout * 1000;
      const actualDueDate = invoiceState!.terms.dueDate!;

      expect(actualDueDate).toBeGreaterThanOrEqual(expectedDueDate);
      expect(actualDueDate).toBeLessThanOrEqual(expectedDueDate + (afterTime - beforeTime) + 100);
    });
  });

  describe('createPayoutInvoice()', () => {
    it('should create payout A with party A\'s DIRECT address and party B\'s currency', async () => {
      const result = await invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        manifest.party_a_address,
        manifest.party_b_currency_to_change,
        manifest.party_b_value_to_change,
        'A',
      );

      expect(result.success).toBe(true);
      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);

      expect(invoiceState!.terms.targets).toHaveLength(1);
      expect(invoiceState!.terms.targets![0].address).toBe(manifest.party_a_address);

      const assets = invoiceState!.terms.targets![0].assets || [];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual({ coin: [manifest.party_b_currency_to_change, manifest.party_b_value_to_change] });
    });

    it('should create payout B with party B\'s DIRECT address and party A\'s currency', async () => {
      const result = await invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        manifest.party_b_address,
        manifest.party_a_currency_to_change,
        manifest.party_a_value_to_change,
        'B',
      );

      expect(result.success).toBe(true);
      const invoiceState = mockAccounting._getInvoiceState(result.invoiceId!);

      expect(invoiceState!.terms.targets).toHaveLength(1);
      expect(invoiceState!.terms.targets![0].address).toBe(manifest.party_b_address);

      const assets = invoiceState!.terms.targets![0].assets || [];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual({ coin: [manifest.party_a_currency_to_change, manifest.party_a_value_to_change] });
    });

    it('should set memo to "Swap <swap_id> payout to Party <A|B>"', async () => {
      const resultA = await invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        manifest.party_a_address,
        manifest.party_b_currency_to_change,
        manifest.party_b_value_to_change,
        'A',
      );

      expect(resultA.success).toBe(true);
      const invoiceStateA = mockAccounting._getInvoiceState(resultA.invoiceId!);
      expect(invoiceStateA!.terms.memo).toBe(`Swap ${manifest.swap_id} payout to Party A`);

      const resultB = await invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        manifest.party_b_address,
        manifest.party_a_currency_to_change,
        manifest.party_a_value_to_change,
        'B',
      );

      expect(resultB.success).toBe(true);
      const invoiceStateB = mockAccounting._getInvoiceState(resultB.invoiceId!);
      expect(invoiceStateB!.terms.memo).toBe(`Swap ${manifest.swap_id} payout to Party B`);
    });
  });

  describe('Error Code Handling', () => {
    it('should propagate INVOICE_ALREADY_CLOSED when closeInvoice() on closed invoice', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      await invoiceManager.closeDepositInvoice(invoiceId);

      // Close again — should throw
      await expect(invoiceManager.closeDepositInvoice(invoiceId)).rejects.toMatchObject({
        code: 'INVOICE_ALREADY_CLOSED',
      });
    });

    it('should propagate INVOICE_ALREADY_CANCELLED when closeInvoice() on cancelled invoice', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      await invoiceManager.cancelDepositInvoice(invoiceId);

      // Close after cancel — should throw
      await expect(invoiceManager.closeDepositInvoice(invoiceId)).rejects.toMatchObject({
        code: 'INVOICE_ALREADY_CANCELLED',
      });
    });

    it('should propagate INVOICE_ALREADY_CANCELLED when cancelInvoice() on cancelled invoice', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      await invoiceManager.cancelDepositInvoice(invoiceId);

      // Cancel again — should throw
      await expect(invoiceManager.cancelDepositInvoice(invoiceId)).rejects.toMatchObject({
        code: 'INVOICE_ALREADY_CANCELLED',
      });
    });

    it('should propagate INVOICE_ALREADY_CLOSED when cancelInvoice() on closed invoice', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      await invoiceManager.closeDepositInvoice(invoiceId);

      // Cancel after close — should throw
      await expect(invoiceManager.cancelDepositInvoice(invoiceId)).rejects.toMatchObject({
        code: 'INVOICE_ALREADY_CLOSED',
      });
    });

    it('should propagate INVOICE_INVALID_AMOUNT when payInvoice() with remaining = 0 (omit amount param)', async () => {
      const payoutResult = await invoiceManager.createPayoutInvoice(
        manifest.swap_id,
        manifest.party_a_address,
        manifest.party_b_currency_to_change,
        manifest.party_b_value_to_change,
        'A',
      );
      const invoiceId = payoutResult.invoiceId!;

      // Create a mock that throws INVOICE_INVALID_AMOUNT error
      const mockError = new Error('Invoice invalid amount');
      (mockError as any).code = 'INVOICE_INVALID_AMOUNT';

      const payInvoiceSpy = vi.spyOn(mockAccounting, 'payInvoice').mockRejectedValueOnce(mockError);

      // Try to pay with no amount specified
      await expect(
        invoiceManager.payInvoice(invoiceId, {
          targetIndex: 0,
          assetIndex: 0,
        }),
      ).rejects.toMatchObject({
        code: 'INVOICE_INVALID_AMOUNT',
      });

      // Verify the method was called with the right params (without amount)
      expect(payInvoiceSpy).toHaveBeenCalledWith(invoiceId, {
        targetIndex: 0,
        assetIndex: 0,
      });

      payInvoiceSpy.mockRestore();
    });
  });

  describe('returnPayment()', () => {
    it('should pass recipient and amount correctly to returnInvoicePayment()', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      const recipient = 'DIRECT://refund_address';
      const amount = '100';

      const result = await invoiceManager.returnPayment(invoiceId, {
        recipient,
        amount,
        coinId: 'UCT',
      });

      expect(result.status).toBe('completed');
      expect(result.id).toBeDefined();
    });

    it('should include freeText parameter when provided', async () => {
      const depositResult = await invoiceManager.createDepositInvoice(manifest);
      const invoiceId = depositResult.invoiceId!;

      const recipient = 'DIRECT://refund_address';
      const amount = '100';
      const freeText = 'Unmatched payment - returning to sender';

      const result = await invoiceManager.returnPayment(invoiceId, {
        recipient,
        amount,
        coinId: 'UCT',
        freeText,
      });

      expect(result.status).toBe('completed');
      expect(result.id).toBeDefined();
    });
  });
});
