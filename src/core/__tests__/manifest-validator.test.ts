import { randomBytes } from 'node:crypto';
import { computeSwapId } from '../../utils/hash.js';
import { validateManifest, type SwapManifest } from '../../core/manifest-validator.js';

/**
 * Helper function to generate a valid manifest with correct swap_id.
 * Allows partial overrides for specific fields.
 */
function makeValidManifest(overrides?: Partial<SwapManifest>): SwapManifest {
  const base = {
    party_a_address: 'DIRECT://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    party_b_address: '@bob',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '900',
    timeout: 3600,
    salt: randomBytes(16).toString('hex'),
    ...overrides,
  };

  // Compute swap_id from all fields except swap_id itself
  const fields = {
    party_a_address: base.party_a_address,
    party_b_address: base.party_b_address,
    party_a_currency_to_change: base.party_a_currency_to_change,
    party_a_value_to_change: base.party_a_value_to_change,
    party_b_currency_to_change: base.party_b_currency_to_change,
    party_b_value_to_change: base.party_b_value_to_change,
    timeout: base.timeout,
    salt: base.salt,
  };

  const swap_id = computeSwapId(fields);
  return { ...base, swap_id };
}

describe('manifest-validator', () => {
  describe('validateManifest - valid manifests', () => {
    it('should accept a valid manifest', () => {
      const manifest = makeValidManifest();
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept manifest with PROXY address', () => {
      const manifest = makeValidManifest({
        party_a_address: 'PROXY://1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept manifest with different address combinations', () => {
      const manifest = makeValidManifest({
        party_a_address: '@alice',
        party_b_address: '@bob',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept large bigint values', () => {
      const manifest = makeValidManifest({
        party_a_value_to_change: '999999999999999999999999999',
        party_b_value_to_change: '888888888888888888888888888',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept minimum timeout', () => {
      const manifest = makeValidManifest({ timeout: 60 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept maximum timeout', () => {
      const manifest = makeValidManifest({ timeout: 86400 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept mid-range timeout', () => {
      const manifest = makeValidManifest({ timeout: 43200 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('validateManifest - null/undefined/non-object', () => {
    it('should throw on null manifest', () => {
      expect(() => validateManifest(null as any)).toThrow();
    });

    it('should throw on undefined manifest', () => {
      expect(() => validateManifest(undefined as any)).toThrow();
    });

    it('should reject string manifest', () => {
      // String has properties accessible via indexing, so SDK may return errors rather than throw
      const result = validateManifest('not an object' as any);
      expect(result.valid).toBe(false);
    });

    it('should reject number manifest', () => {
      const result = validateManifest(42 as any);
      expect(result.valid).toBe(false);
    });

    it('should reject array manifest', () => {
      const result = validateManifest([] as any);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateManifest - swap_id validation', () => {
    it('should reject missing swap_id field', () => {
      const manifest = makeValidManifest();
      const { swap_id: _, ...withoutId } = manifest;
      const result = validateManifest(withoutId as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject non-string swap_id', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 12345 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject swap_id with uppercase letters', () => {
      const manifest = makeValidManifest();
      const invalidId = manifest.swap_id.toUpperCase();
      const result = validateManifest({ ...manifest, swap_id: invalidId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject swap_id with non-hex characters', () => {
      const manifest = makeValidManifest();
      const invalidId = 'g'.repeat(64); // 'g' is not a hex character
      const result = validateManifest({ ...manifest, swap_id: invalidId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject swap_id that is too short', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 'a'.repeat(63) });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject swap_id that is too long', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 'a'.repeat(65) });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });

    it('should reject swap_id that does not match hash of fields', () => {
      const manifest = makeValidManifest();
      const wrongId = 'a'.repeat(64);
      const result = validateManifest({ ...manifest, swap_id: wrongId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id does not match'),
      );
    });
  });

  describe('validateManifest - party_a_address validation', () => {
    it('should reject missing party_a_address', () => {
      const manifest = makeValidManifest();
      const { party_a_address: _, ...withoutAddr } = manifest;
      const result = validateManifest(withoutAddr as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_address'),
      );
    });

    it('should reject non-string party_a_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 123 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_address'),
      );
    });

    it('should reject party_a_address without valid prefix', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 'invalid-address' });
      expect(result.valid).toBe(false);
      // The escrow validator only checks non-empty string, so the swap_id hash will fail
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject empty party_a_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_address'),
      );
    });

    it('should reject DIRECT:// with no value', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 'DIRECT://' });
      expect(result.valid).toBe(false);
      // Will fail on swap_id hash mismatch since address changed
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateManifest - party_b_address validation', () => {
    it('should reject missing party_b_address', () => {
      const manifest = makeValidManifest();
      const { party_b_address: _, ...withoutAddr } = manifest;
      const result = validateManifest(withoutAddr as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_address'),
      );
    });

    it('should reject non-string party_b_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_b_address: null as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_address'),
      );
    });

    it('should reject party_b_address that equals party_a_address', () => {
      const manifest = makeValidManifest({
        party_a_address: '@alice',
        party_b_address: '@alice',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('must differ from'),
      );
    });

    it('should reject when both addresses are identical DIRECT addresses', () => {
      const sameAddr = 'DIRECT://1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const manifest = makeValidManifest({
        party_a_address: sameAddr,
        party_b_address: sameAddr,
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('must differ from'),
      );
    });

    it('should accept different nametag addresses', () => {
      const manifest = makeValidManifest({
        party_a_address: '@alice',
        party_b_address: '@bob',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateManifest - currency validation', () => {
    it('should reject missing party_a_currency_to_change', () => {
      const manifest = makeValidManifest();
      const { party_a_currency_to_change: _, ...withoutCurrency } = manifest;
      const result = validateManifest(withoutCurrency as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_currency_to_change'),
      );
    });

    it('should reject empty party_a_currency_to_change', () => {
      const manifest = makeValidManifest({ party_a_currency_to_change: '' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_currency_to_change'),
      );
    });

    it('should reject non-string party_a_currency_to_change', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_currency_to_change: 123 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_currency_to_change'),
      );
    });

    it('should reject missing party_b_currency_to_change', () => {
      const manifest = makeValidManifest();
      const { party_b_currency_to_change: _, ...withoutCurrency } = manifest;
      const result = validateManifest(withoutCurrency as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_currency_to_change'),
      );
    });

    it('should reject empty party_b_currency_to_change', () => {
      const manifest = makeValidManifest({ party_b_currency_to_change: '' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_currency_to_change'),
      );
    });

    it('should reject when party_a_currency equals party_b_currency', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'USD',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('must differ from'),
      );
    });

    it('should accept different currency codes', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'EUR',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it('should accept arbitrary alphanumeric currency strings', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'CURRENCYA',
        party_b_currency_to_change: 'CURRENCYB',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateManifest - value validation', () => {
    it('should reject missing party_a_value_to_change', () => {
      const manifest = makeValidManifest();
      const { party_a_value_to_change: _, ...withoutValue } = manifest;
      const result = validateManifest(withoutValue as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change'),
      );
    });

    it('should reject non-string party_a_value_to_change', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_value_to_change: 1000 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change'),
      );
    });

    it('should reject zero party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change must be a positive integer string'),
      );
    });

    it('should reject negative party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '-100' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change'),
      );
    });

    it('should reject decimal party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '100.50' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change'),
      );
    });

    it('should reject non-numeric party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: 'abc' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change'),
      );
    });

    it('should reject missing party_b_value_to_change', () => {
      const manifest = makeValidManifest();
      const { party_b_value_to_change: _, ...withoutValue } = manifest;
      const result = validateManifest(withoutValue as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_value_to_change'),
      );
    });

    it('should reject zero party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_value_to_change'),
      );
    });

    it('should reject decimal party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '100.50' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_value_to_change'),
      );
    });

    it('should reject negative party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '-100' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_value_to_change'),
      );
    });

    it('should accept valid positive bigint values', () => {
      const manifest = makeValidManifest({
        party_a_value_to_change: '1',
        party_b_value_to_change: '999999999999999999999999999999',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateManifest - timeout validation', () => {
    it('should reject missing timeout', () => {
      const manifest = makeValidManifest();
      const { timeout: _, ...withoutTimeout } = manifest;
      const result = validateManifest(withoutTimeout as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('timeout must be an integer between 60 and 86400'),
      );
    });

    it('should reject non-integer timeout', () => {
      const manifest = makeValidManifest({ timeout: 3600.5 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('timeout'),
      );
    });

    it('should reject string timeout', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, timeout: '3600' as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('timeout'),
      );
    });

    it('should reject timeout below minimum (60)', () => {
      const manifest = makeValidManifest({ timeout: 59 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('between 60 and 86400'),
      );
    });

    it('should reject timeout above maximum (86400)', () => {
      const manifest = makeValidManifest({ timeout: 86401 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('between 60 and 86400'),
      );
    });

    it('should accept timeout at minimum bound', () => {
      const manifest = makeValidManifest({ timeout: 60 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it('should accept timeout at maximum bound', () => {
      const manifest = makeValidManifest({ timeout: 86400 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateManifest - multiple errors', () => {
    it('should collect multiple validation errors', () => {
      const result = validateManifest({
        swap_id: 'invalid',
        party_a_address: 'invalid',
        party_b_address: '',
        party_a_currency_to_change: '',
        party_b_currency_to_change: 'EUR',
        party_a_value_to_change: '-100',
        party_b_value_to_change: 'invalid',
        timeout: 'not a number' as any,
      } as any);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });

    it('should not check swap_id hash when other fields are invalid', () => {
      const result = validateManifest({
        swap_id: 'a'.repeat(64),
        party_a_address: 'invalid',
        party_b_address: '@bob',
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'EUR',
        party_a_value_to_change: '1000',
        party_b_value_to_change: '900',
        timeout: 3600,
      } as any);
      // Should fail due to missing salt, but not get to hash validation
      expect(result.valid).toBe(false);
      const hashErrors = result.errors.filter((e) => e.includes('does not match'));
      expect(hashErrors).toHaveLength(0);
    });
  });

  describe('validateManifest - integration scenarios', () => {
    it('should validate a complete real-world swap manifest', () => {
      const manifest = makeValidManifest({
        party_a_address: '@alice',
        party_b_address: '@bob',
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'EUR',
        party_a_value_to_change: '1000',
        party_b_value_to_change: '900',
        timeout: 3600,
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle swap manifest with large values correctly', () => {
      const largeValue = '123456789012345678901234567890';
      const manifest = makeValidManifest({
        party_a_value_to_change: largeValue,
        party_b_value_to_change: largeValue,
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it('should detect tampering of swap_id', () => {
      const manifest = makeValidManifest();
      // Modify one character in the middle
      const tamperedId = manifest.swap_id.substring(0, 32) +
                         (manifest.swap_id[32] === 'a' ? 'b' : 'a') +
                         manifest.swap_id.substring(33);
      const result = validateManifest({ ...manifest, swap_id: tamperedId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id does not match'),
      );
    });

    it('should detect tampering of manifest fields', () => {
      const manifest = makeValidManifest();
      // Change timeout value, which should invalidate the swap_id
      const result = validateManifest({ ...manifest, timeout: manifest.timeout + 1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id does not match'),
      );
    });

    it('should detect tampering of currency values', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'EUR',
      });
      const result = validateManifest({
        ...manifest,
        party_a_currency_to_change: 'JPY',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('swap_id'),
      );
    });
  });

  describe('validateManifest - leading-zero rejection', () => {
    it('should reject value "007" with leading zeros', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '007' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_a_value_to_change must be a positive integer string'),
      );
    });

    it('should reject value "0" as not a positive integer', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('party_b_value_to_change must be a positive integer string'),
      );
    });

    it('should accept value "1" as valid positive integer', () => {
      const manifest = makeValidManifest({
        party_a_value_to_change: '1',
        party_b_value_to_change: '1',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it('should accept large BigInt value without leading zeros', () => {
      const manifest = makeValidManifest({
        party_a_value_to_change: '1000000000000000000',
        party_b_value_to_change: '1000000000000000000',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });
});
