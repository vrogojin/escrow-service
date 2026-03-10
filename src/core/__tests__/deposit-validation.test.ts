import { describe, it, expect } from 'vitest';
import {
  identifyParty,
  validateCurrency,
  getEffectiveSender,
  validateDeposit,
} from '../deposit-validator.js';
import { createMockTransferRef } from '../../__tests__/helpers/mock-invoice-status.js';

const PARTY_A_ADDRESS = 'DIRECT://0xaaaaaa';
const PARTY_B_ADDRESS = 'DIRECT://0xbbbbbb';
const CHARLIE_ADDRESS = 'DIRECT://0xcccccc';

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

describe('identifyParty', () => {
  it('should identify party A by matching senderAddress against resolved_party_a_address', () => {
    const result = identifyParty(PARTY_A_ADDRESS, PARTY_A_ADDRESS, PARTY_B_ADDRESS);
    expect(result).toBe('A');
  });

  it('should identify party B by matching senderAddress against resolved_party_b_address', () => {
    const result = identifyParty(PARTY_B_ADDRESS, PARTY_A_ADDRESS, PARTY_B_ADDRESS);
    expect(result).toBe('B');
  });

  it('should return null for senderAddress that matches neither party', () => {
    const result = identifyParty(CHARLIE_ADDRESS, PARTY_A_ADDRESS, PARTY_B_ADDRESS);
    expect(result).toBeNull();
  });

  it('should use case-sensitive exact string match for DIRECT:// address comparison', () => {
    const result = identifyParty(
      'DIRECT://0xAAAAAA',
      PARTY_A_ADDRESS,
      PARTY_B_ADDRESS,
    );
    expect(result).toBeNull();
  });

  it('should return null when senderAddress is null (masked predicate)', () => {
    const result = identifyParty(null, PARTY_A_ADDRESS, PARTY_B_ADDRESS);
    expect(result).toBeNull();
  });
});

describe('validateCurrency', () => {
  it('should accept party A paying party_a_currency_to_change', () => {
    const result = validateCurrency('A', 'USD', MANIFEST);
    expect(result).toBe(true);
  });

  it('should accept party B paying party_b_currency_to_change', () => {
    const result = validateCurrency('B', 'EUR', MANIFEST);
    expect(result).toBe(true);
  });

  it('should reject party A paying party_b_currency_to_change', () => {
    const result = validateCurrency('A', 'EUR', MANIFEST);
    expect(result).toBe(false);
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
  it('should return valid result for party A with correct currency', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.party).toBe('A');
    expect(result.reason).toBeUndefined();
    expect(result.senderAddress).toBe(PARTY_A_ADDRESS);
    expect(result.coinId).toBe('USD');
  });

  it('should return MASKED_PREDICATE reason when senderAddress is null', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: null,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.party).toBeNull();
    expect(result.reason).toBe('MASKED_PREDICATE');
  });

  it('should return UNKNOWN_SENDER when sender does not match either party', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: CHARLIE_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.party).toBeNull();
    expect(result.reason).toBe('UNKNOWN_SENDER');
  });

  it('should return WRONG_CURRENCY when party A pays party B currency', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'EUR',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.party).toBe('A');
    expect(result.reason).toBe('WRONG_CURRENCY');
  });

  it('should include effectiveSender in result for return routing', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: PARTY_A_ADDRESS,
      refundAddress: 'DIRECT://0xrefund',
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.effectiveSender).toBe('DIRECT://0xrefund');
  });

  it('should include transferId and amount in result', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx123',
      senderAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
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
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.amount).toBe('123456789012345678901234567890');
  });

  it('should NOT use effectiveSender for identity (spoofing test: charlie senderAddress with partyA refundAddress still returns party=null)', () => {
    const transfer = createMockTransferRef({
      transferId: 'tx1',
      senderAddress: CHARLIE_ADDRESS,
      refundAddress: PARTY_A_ADDRESS,
      amount: '1000000',
      coinId: 'USD',
    });
    const result = validateDeposit(transfer, PARTY_A_ADDRESS, PARTY_B_ADDRESS, MANIFEST);
    expect(result.party).toBeNull();
    expect(result.reason).toBe('UNKNOWN_SENDER');
    expect(result.senderAddress).toBe(CHARLIE_ADDRESS);
    expect(result.effectiveSender).toBe(PARTY_A_ADDRESS);
  });
});
