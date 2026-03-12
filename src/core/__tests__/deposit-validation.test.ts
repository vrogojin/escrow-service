import { describe, it, expect } from 'vitest';
import {
  identifyPartySide,
  getEffectiveSender,
  validateDeposit,
} from '../deposit-validator.js';
import { createMockTransferRef } from '../../__tests__/helpers/mock-invoice-status.js';

const PARTY_A_ADDRESS = 'DIRECT://0xaaaaaa';
const PARTY_B_ADDRESS = 'DIRECT://0xbbbbbb';

const MANIFEST = {
  swap_id: 'test-swap',
  party_a_address: PARTY_A_ADDRESS,
  party_b_address: PARTY_B_ADDRESS,
  party_a_currency_to_change: 'USD',
  party_a_value_to_change: '1000000',
  party_b_currency_to_change: 'EUR',
  party_b_value_to_change: '850000',
  timeout: 300,
};

describe('identifyPartySide', () => {
  it("should return 'A' when coinId matches party_a_currency", () => {
    const result = identifyPartySide('USD', MANIFEST);
    expect(result).toBe('A');
  });

  it("should return 'B' when coinId matches party_b_currency", () => {
    const result = identifyPartySide('EUR', MANIFEST);
    expect(result).toBe('B');
  });

  it('should return null when coinId matches neither currency', () => {
    const result = identifyPartySide('GBP', MANIFEST);
    expect(result).toBeNull();
  });
});

describe('getEffectiveSender', () => {
  it('should return refundAddress when present (refundAddress ?? senderAddress)', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      refundAddress: 'DIRECT://0xrefund',
      amount: '100000',
      coinId: 'USD',
    });
    const result = getEffectiveSender(transfer);
    expect(result).toBe('DIRECT://0xrefund');
  });

  it('should return senderAddress when no refundAddress', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '100000',
      coinId: 'USD',
    });
    const result = getEffectiveSender(transfer);
    expect(result).toBe(PARTY_A_ADDRESS);
  });

  it('should return null when both are absent', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: null,
      amount: '100000',
      coinId: 'USD',
    });
    const result = getEffectiveSender(transfer);
    expect(result).toBeNull();
  });

  it('should prefer refundAddress over senderAddress even when both exist', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      refundAddress: 'DIRECT://0xrefund',
      amount: '100000',
      coinId: 'USD',
    });
    const result = getEffectiveSender(transfer);
    expect(result).toBe('DIRECT://0xrefund');
    expect(result).not.toBe(PARTY_A_ADDRESS);
  });
});

describe('validateDeposit', () => {
  it("should return partySide 'A' for valid party_a_currency deposit (any sender)", () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.partySide).toBe('A');
    expect(result.reason).toBeUndefined();
    expect(result.coinId).toBe('USD');
  });

  it("should return partySide 'B' for valid party_b_currency deposit (any sender)", () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_B_ADDRESS,
      amount: '850000',
      coinId: 'EUR',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.partySide).toBe('B');
    expect(result.reason).toBeUndefined();
    expect(result.coinId).toBe('EUR');
  });

  it('should return WRONG_CURRENCY for unknown coinId', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'GBP',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.partySide).toBeNull();
    expect(result.reason).toBe('WRONG_CURRENCY');
  });

  it('should accept deposit from unknown sender if currency matches', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: 'DIRECT://0xcccccc',
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.partySide).toBe('A');
    expect(result.reason).toBeUndefined();
  });

  it('should accept deposit with null senderAddress AND null refundAddress (masked predicate — currency match takes precedence)', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: null,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    // Masked deposits are accepted per architecture spec — currency match takes precedence.
    // Surplus return for masked deposits with no refundAddress may require manual intervention.
    expect(result.partySide).toBe('A');
    expect(result.reason).toBeUndefined();
    expect(result.effectiveSender).toBeNull();
  });

  it('should accept deposit with null senderAddress but present refundAddress (masked predicate with return route)', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: null,
      refundAddress: 'DIRECT://0xrefund',
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.partySide).toBe('A');
    expect(result.reason).toBeUndefined();
    expect(result.effectiveSender).toBe('DIRECT://0xrefund');
  });

  it('should populate effectiveSender from refundAddress ?? senderAddress', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      refundAddress: 'DIRECT://0xrefund',
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.effectiveSender).toBe('DIRECT://0xrefund');
  });

  it('should include transferId and amount in result', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx123',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.transferId).toBe('tx123');
    expect(result.amount).toBe('1000000');
  });

  it('should handle BigInt amount strings without precision loss', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '123456789012345678901234567890',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, MANIFEST);
    expect(result.amount).toBe('123456789012345678901234567890');
  });
});
