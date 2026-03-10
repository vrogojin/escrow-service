import { InMemorySwapStateStore } from '../swap-state-store.js';
import { SwapState } from '../state-machine.js';
import type { SwapManifest, ResolvedAddresses } from '../types.js';
import { computeSwapId } from '../../utils/hash.js';

function createTestManifest(overrides?: Partial<SwapManifest>): SwapManifest {
  const base = {
    party_a_address: 'DIRECT://party_a_pubkey',
    party_b_address: 'DIRECT://party_b_pubkey',
    party_a_currency_to_change: 'UCT',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'USDU',
    party_b_value_to_change: '500',
    timeout: 600,
    ...overrides,
  };

  const fields = {
    party_a_address: base.party_a_address,
    party_b_address: base.party_b_address,
    party_a_currency_to_change: base.party_a_currency_to_change,
    party_a_value_to_change: base.party_a_value_to_change,
    party_b_currency_to_change: base.party_b_currency_to_change,
    party_b_value_to_change: base.party_b_value_to_change,
    timeout: base.timeout,
  };

  const swap_id = computeSwapId(fields);
  return { ...base, swap_id };
}

function createTestResolvedAddresses(): ResolvedAddresses {
  return {
    partyA: 'DIRECT://party_a_pubkey',
    partyB: 'DIRECT://party_b_pubkey',
  };
}

describe('InMemorySwapStateStore', () => {
  describe('CRUD Operations', () => {
    it('should create swap record with manifest, state=ANNOUNCED, resolved addresses', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const record = store.create(manifest, addresses);

      expect(record.swap_id).toBe(manifest.swap_id);
      expect(record.manifest).toEqual(manifest);
      expect(record.state).toBe(SwapState.ANNOUNCED);
      expect(record.resolved_party_a_address).toBe(addresses.partyA);
      expect(record.resolved_party_b_address).toBe(addresses.partyB);
      expect(record.version).toBe(1);
      expect(record.deposit_invoice_id).toBeNull();
      expect(record.payout_a_invoice_id).toBeNull();
      expect(record.payout_b_invoice_id).toBeNull();
    });

    it('should find swap by swap_id', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const found = store.findBySwapId(manifest.swap_id);

      expect(found).not.toBeNull();
      expect(found?.swap_id).toBe(manifest.swap_id);
      expect(found?.state).toBe(SwapState.ANNOUNCED);
    });

    it('should find swap by deposit_invoice_id', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const invoiceId = 'a'.repeat(64);
      const updated = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      const found = store.findByInvoiceId(invoiceId);
      expect(found).not.toBeNull();
      expect(found?.swap_id).toBe(manifest.swap_id);
      expect(found?.deposit_invoice_id).toBe(invoiceId);
    });

    it('should find swap by payout_a_invoice_id or payout_b_invoice_id', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const payoutAInvoiceId = 'b'.repeat(64);
      const payoutBInvoiceId = 'c'.repeat(64);

      const updated = store.updateState(
        manifest.swap_id,
        SwapState.CONCLUDING,
        { payout_a_invoice_id: payoutAInvoiceId, payout_b_invoice_id: payoutBInvoiceId },
        1,
      );

      const foundByA = store.findByInvoiceId(payoutAInvoiceId);
      const foundByB = store.findByInvoiceId(payoutBInvoiceId);

      expect(foundByA).not.toBeNull();
      expect(foundByA?.payout_a_invoice_id).toBe(payoutAInvoiceId);
      expect(foundByB).not.toBeNull();
      expect(foundByB?.payout_b_invoice_id).toBe(payoutBInvoiceId);
    });

    it('should return null for non-existent swap_id', () => {
      const store = new InMemorySwapStateStore();
      const found = store.findBySwapId('z'.repeat(64));
      expect(found).toBeNull();
    });
  });

  describe('State Updates with Optimistic Locking', () => {
    it('should update state and increment version on success', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      expect(created.version).toBe(1);

      const updated = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        {},
        1,
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(updated?.version).toBe(2);
    });

    it('should return null when expectedVersion does not match', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);

      const result = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        {},
        99, // Wrong version
      );

      expect(result).toBeNull();
    });

    it('should update deposit_invoice_id alongside state transition', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const invoiceId = 'a'.repeat(64);

      const updated = store.updateState(
        manifest.swap_id,
        SwapState.DEPOSIT_INVOICE_CREATED,
        { deposit_invoice_id: invoiceId },
        1,
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(updated?.deposit_invoice_id).toBe(invoiceId);
      expect(updated?.version).toBe(2);
    });

    it('should update payout_a_invoice_id and payout_b_invoice_id alongside CONCLUDING transition', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const payoutAInvoiceId = 'b'.repeat(64);
      const payoutBInvoiceId = 'c'.repeat(64);

      const updated = store.updateState(
        manifest.swap_id,
        SwapState.CONCLUDING,
        { payout_a_invoice_id: payoutAInvoiceId, payout_b_invoice_id: payoutBInvoiceId },
        1,
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(SwapState.CONCLUDING);
      expect(updated?.payout_a_invoice_id).toBe(payoutAInvoiceId);
      expect(updated?.payout_b_invoice_id).toBe(payoutBInvoiceId);
      expect(updated?.version).toBe(2);
    });
  });

  describe('Query Methods', () => {
    it('should return all non-terminal swaps via findNonTerminal', () => {
      const store = new InMemorySwapStateStore();
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_party_a',
        party_b_address: 'DIRECT://other_party_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(2);
    });

    it('should not include COMPLETED swaps in findNonTerminal', () => {
      const store = new InMemorySwapStateStore();
      const manifest = createTestManifest();
      const addresses = createTestResolvedAddresses();

      const created = store.create(manifest, addresses);
      const updated = store.updateState(
        manifest.swap_id,
        SwapState.COMPLETED,
        {},
        1,
      );

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(0);
    });

    it('should not include CANCELLED or FAILED swaps in findNonTerminal', () => {
      const store = new InMemorySwapStateStore();
      const manifest1 = createTestManifest();
      const manifest2 = createTestManifest({
        party_a_address: 'DIRECT://other_party_a',
        party_b_address: 'DIRECT://other_party_b',
      });
      const manifest3 = createTestManifest({
        party_a_address: 'DIRECT://third_party_a',
        party_b_address: 'DIRECT://third_party_b',
      });
      const addresses = createTestResolvedAddresses();

      store.create(manifest1, addresses);
      store.create(manifest2, addresses);
      store.create(manifest3, addresses);

      store.updateState(manifest1.swap_id, SwapState.CANCELLED, {}, 1);
      store.updateState(manifest2.swap_id, SwapState.FAILED, {}, 1);

      const nonTerminal = store.findNonTerminal();
      expect(nonTerminal).toHaveLength(1);
      expect(nonTerminal[0].swap_id).toBe(manifest3.swap_id);
    });
  });
});
