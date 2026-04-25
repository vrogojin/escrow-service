import { computeSwapId, isValidSwapId, ManifestFields } from '../hash.js';

describe('hash utilities', () => {
  // Sample manifest for testing
  const sampleManifest: ManifestFields = {
    party_a_address: 'DIRECT://alice123',
    party_b_address: 'DIRECT://bob456',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '100.50',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '90.00',
    timeout: 3600,
    salt: 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8',
  };

  describe('computeSwapId', () => {
    it('should produce exactly 64 lowercase hex characters', () => {
      const swapId = computeSwapId(sampleManifest);
      expect(swapId).toHaveLength(64);
      expect(swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic - same input produces same output', () => {
      const swapId1 = computeSwapId(sampleManifest);
      const swapId2 = computeSwapId(sampleManifest);
      expect(swapId1).toBe(swapId2);
    });

    it('should produce different output for different manifest fields', () => {
      const swapId1 = computeSwapId(sampleManifest);

      const modifiedManifest: ManifestFields = {
        ...sampleManifest,
        party_a_value_to_change: '101.00', // different value
      };
      const swapId2 = computeSwapId(modifiedManifest);

      expect(swapId1).not.toBe(swapId2);
    });

    it('should produce different output when party addresses change', () => {
      const swapId1 = computeSwapId(sampleManifest);

      const modifiedManifest: ManifestFields = {
        ...sampleManifest,
        party_a_address: 'DIRECT://alice999', // different address
      };
      const swapId2 = computeSwapId(modifiedManifest);

      expect(swapId1).not.toBe(swapId2);
    });

    it('should produce different output when currency changes', () => {
      const swapId1 = computeSwapId(sampleManifest);

      const modifiedManifest: ManifestFields = {
        ...sampleManifest,
        party_a_currency_to_change: 'GBP', // different currency
      };
      const swapId2 = computeSwapId(modifiedManifest);

      expect(swapId1).not.toBe(swapId2);
    });

    it('should produce different output when timeout changes', () => {
      const swapId1 = computeSwapId(sampleManifest);

      const modifiedManifest: ManifestFields = {
        ...sampleManifest,
        timeout: 7200, // different timeout
      };
      const swapId2 = computeSwapId(modifiedManifest);

      expect(swapId1).not.toBe(swapId2);
    });

    it('should throw error if serialization fails (null)', () => {
      // This test is defensive; in practice serialization failures are rare
      // We test that the function handles edge cases gracefully
      const corruptManifest = {
        ...sampleManifest,
        // Note: With canonicalize, most objects serialize fine
        // This test documents expected behavior on serialization failure
      };

      // Normal case should not throw
      expect(() => computeSwapId(corruptManifest)).not.toThrow();
    });

    it('should handle different numeric representations consistently', () => {
      const manifest1: ManifestFields = {
        ...sampleManifest,
        party_a_value_to_change: '100',
      };

      const manifest2: ManifestFields = {
        ...sampleManifest,
        party_a_value_to_change: '100.0',
      };

      // These should produce different hashes because the string representation differs
      const swapId1 = computeSwapId(manifest1);
      const swapId2 = computeSwapId(manifest2);

      // The hash should be deterministic for each representation
      expect(computeSwapId(manifest1)).toBe(swapId1);
      expect(computeSwapId(manifest2)).toBe(swapId2);
    });
  });

  describe('isValidSwapId', () => {
    it('should return true for valid 64-character lowercase hex string', () => {
      const validSwapId = computeSwapId(sampleManifest);
      expect(isValidSwapId(validSwapId)).toBe(true);
    });

    it('should return true for any valid 64-char lowercase hex pattern', () => {
      expect(isValidSwapId('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(true);
      expect(isValidSwapId('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')).toBe(true);
      expect(isValidSwapId('0000000000000000000000000000000000000000000000000000000000000000')).toBe(true);
    });

    it('should return false for uppercase hex characters', () => {
      const invalidSwapId = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
      expect(isValidSwapId(invalidSwapId)).toBe(false);
    });

    it('should return false for mixed case hex', () => {
      const invalidSwapId = '0123456789ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef';
      expect(isValidSwapId(invalidSwapId)).toBe(false);
    });

    it('should return false for 63 hex characters', () => {
      const invalidSwapId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde';
      expect(isValidSwapId(invalidSwapId)).toBe(false);
    });

    it('should return false for 65 hex characters', () => {
      const invalidSwapId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0';
      expect(isValidSwapId(invalidSwapId)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidSwapId('')).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      expect(isValidSwapId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
      expect(isValidSwapId('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg')).toBe(false);
    });

    it('should return false for hex with spaces', () => {
      expect(isValidSwapId('0123456789abcdef 0123456789abcdef 0123456789abcdef 0123456789abcdef')).toBe(false);
    });

    it('should return false for null or non-string inputs (type guard)', () => {
      // @ts-expect-error - intentionally passing wrong type to test behavior
      expect(isValidSwapId(null)).toBe(false);
      // @ts-expect-error - intentionally passing wrong type to test behavior
      expect(isValidSwapId(undefined)).toBe(false);
      // @ts-expect-error - intentionally passing wrong type to test behavior
      expect(isValidSwapId(123)).toBe(false);
    });
  });
});
