import { computeSwapId } from '../../utils/hash.js';
import { validateManifest, type SwapManifest } from '../../core/manifest-validator.js';

/**
 * Helper function to generate a valid manifest with correct swap_id.
 * Allows partial overrides for specific fields.
 */
function makeValidManifest(overrides?: Partial<SwapManifest>): SwapManifest {
  const base = {
    party_a_address: 'DIRECT://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
    party_b_address: '@bob',
    party_a_currency_to_change: 'USD',
    party_a_value_to_change: '1000',
    party_b_currency_to_change: 'EUR',
    party_b_value_to_change: '900',
    timeout: 3600,
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
    it('should reject null manifest', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'manifest',
        message: expect.stringContaining('non-null object'),
      }));
    });

    it('should reject undefined manifest', () => {
      const result = validateManifest(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'manifest',
        message: expect.stringContaining('non-null object'),
      }));
    });

    it('should reject string manifest', () => {
      const result = validateManifest('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'manifest',
        message: expect.stringContaining('non-null object'),
      }));
    });

    it('should reject number manifest', () => {
      const result = validateManifest(42);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'manifest',
        message: expect.stringContaining('non-null object'),
      }));
    });

    it('should reject array manifest', () => {
      const result = validateManifest([]);
      expect(result.valid).toBe(false);
      // Array is technically an object, so we'll get field-level errors
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateManifest - swap_id validation', () => {
    it('should reject missing swap_id field', () => {
      const manifest = makeValidManifest();
      const { swap_id: _, ...withoutId } = manifest;
      const result = validateManifest(withoutId);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject non-string swap_id', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 12345 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject swap_id with uppercase letters', () => {
      const manifest = makeValidManifest();
      const invalidId = manifest.swap_id.toUpperCase();
      const result = validateManifest({ ...manifest, swap_id: invalidId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject swap_id with non-hex characters', () => {
      const manifest = makeValidManifest();
      const invalidId = 'g'.repeat(64); // 'g' is not a hex character
      const result = validateManifest({ ...manifest, swap_id: invalidId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject swap_id that is too short', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 'a'.repeat(63) });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject swap_id that is too long', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, swap_id: 'a'.repeat(65) });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('64 lowercase hex'),
      }));
    });

    it('should reject swap_id that does not match hash of fields', () => {
      const manifest = makeValidManifest();
      const wrongId = 'a'.repeat(64);
      const result = validateManifest({ ...manifest, swap_id: wrongId });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('SHA-256 hash'),
      }));
    });
  });

  describe('validateManifest - party_a_address validation', () => {
    it('should reject missing party_a_address', () => {
      const manifest = makeValidManifest();
      const { party_a_address: _, ...withoutAddr } = manifest;
      const result = validateManifest(withoutAddr);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_address',
        message: expect.stringContaining('valid Sphere address'),
      }));
    });

    it('should reject non-string party_a_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 123 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_address',
      }));
    });

    it('should reject party_a_address without valid prefix', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 'invalid-address' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_address',
      }));
    });

    it('should reject empty party_a_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_address',
      }));
    });

    it('should reject DIRECT:// with no value', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_address: 'DIRECT://' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_address',
      }));
    });
  });

  describe('validateManifest - party_b_address validation', () => {
    it('should reject missing party_b_address', () => {
      const manifest = makeValidManifest();
      const { party_b_address: _, ...withoutAddr } = manifest;
      const result = validateManifest(withoutAddr);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_address',
      }));
    });

    it('should reject non-string party_b_address', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_b_address: null as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_address',
      }));
    });

    it('should reject party_b_address that equals party_a_address', () => {
      const manifest = makeValidManifest({
        party_a_address: '@alice',
        party_b_address: '@alice',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_address',
        message: expect.stringContaining('Must differ from party_a_address'),
      }));
    });

    it('should reject when both addresses are identical DIRECT addresses', () => {
      const sameAddr = 'DIRECT://1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
      const manifest = makeValidManifest({
        party_a_address: sameAddr,
        party_b_address: sameAddr,
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_address',
        message: expect.stringContaining('Must differ from party_a_address'),
      }));
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
      const result = validateManifest(withoutCurrency);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_currency_to_change',
        message: expect.stringContaining('non-empty string'),
      }));
    });

    it('should reject empty party_a_currency_to_change', () => {
      const manifest = makeValidManifest({ party_a_currency_to_change: '' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_currency_to_change',
        message: expect.stringContaining('non-empty string'),
      }));
    });

    it('should reject non-string party_a_currency_to_change', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_currency_to_change: 123 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_currency_to_change',
      }));
    });

    it('should reject missing party_b_currency_to_change', () => {
      const manifest = makeValidManifest();
      const { party_b_currency_to_change: _, ...withoutCurrency } = manifest;
      const result = validateManifest(withoutCurrency);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_currency_to_change',
      }));
    });

    it('should reject empty party_b_currency_to_change', () => {
      const manifest = makeValidManifest({ party_b_currency_to_change: '' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_currency_to_change',
      }));
    });

    it('should reject when party_a_currency equals party_b_currency', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'USD',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_currency_to_change',
        message: expect.stringContaining('Must differ from party_a_currency_to_change'),
      }));
    });

    it('should accept different currency codes', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'USD',
        party_b_currency_to_change: 'EUR',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it('should accept arbitrary currency strings', () => {
      const manifest = makeValidManifest({
        party_a_currency_to_change: 'CURRENCY_A',
        party_b_currency_to_change: 'CURRENCY_B',
      });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateManifest - value validation', () => {
    it('should reject missing party_a_value_to_change', () => {
      const manifest = makeValidManifest();
      const { party_a_value_to_change: _, ...withoutValue } = manifest;
      const result = validateManifest(withoutValue);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
        message: expect.stringContaining('positive integer'),
      }));
    });

    it('should reject non-string party_a_value_to_change', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, party_a_value_to_change: 1000 as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
      }));
    });

    it('should reject zero party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
        message: expect.stringContaining('positive integer'),
      }));
    });

    it('should reject negative party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '-100' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
      }));
    });

    it('should reject decimal party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '100.50' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
      }));
    });

    it('should reject non-numeric party_a_value_to_change', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: 'abc' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
      }));
    });

    it('should reject missing party_b_value_to_change', () => {
      const manifest = makeValidManifest();
      const { party_b_value_to_change: _, ...withoutValue } = manifest;
      const result = validateManifest(withoutValue);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_value_to_change',
      }));
    });

    it('should reject zero party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_value_to_change',
      }));
    });

    it('should reject decimal party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '100.50' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_value_to_change',
      }));
    });

    it('should reject negative party_b_value_to_change', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '-100' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_value_to_change',
      }));
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
      const result = validateManifest(withoutTimeout);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
        message: expect.stringContaining('integer'),
      }));
    });

    it('should reject non-integer timeout', () => {
      const manifest = makeValidManifest({ timeout: 3600.5 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
      }));
    });

    it('should reject string timeout', () => {
      const manifest = makeValidManifest();
      const result = validateManifest({ ...manifest, timeout: '3600' as any });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
      }));
    });

    it('should reject timeout below minimum (default 60)', () => {
      const manifest = makeValidManifest({ timeout: 59 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
        message: expect.stringContaining('between 60 and 86400'),
      }));
    });

    it('should reject timeout above maximum (default 86400)', () => {
      const manifest = makeValidManifest({ timeout: 86401 });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
        message: expect.stringContaining('between 60 and 86400'),
      }));
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

  describe('validateManifest - custom timeout bounds', () => {
    it('should respect custom timeoutMin option', () => {
      const manifest = makeValidManifest({ timeout: 100 });
      const result = validateManifest(manifest, { timeoutMin: 200 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
        message: expect.stringContaining('between 200 and 86400'),
      }));
    });

    it('should respect custom timeoutMax option', () => {
      const manifest = makeValidManifest({ timeout: 50000 });
      const result = validateManifest(manifest, { timeoutMax: 40000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'timeout',
        message: expect.stringContaining('between 60 and 40000'),
      }));
    });

    it('should accept timeout within custom bounds', () => {
      const manifest = makeValidManifest({ timeout: 500 });
      const result = validateManifest(manifest, {
        timeoutMin: 300,
        timeoutMax: 1000,
      });
      expect(result.valid).toBe(true);
    });

    it('should reject timeout below custom minimum', () => {
      const manifest = makeValidManifest({ timeout: 299 });
      const result = validateManifest(manifest, { timeoutMin: 300 });
      expect(result.valid).toBe(false);
    });

    it('should reject timeout above custom maximum', () => {
      const manifest = makeValidManifest({ timeout: 1001 });
      const result = validateManifest(manifest, { timeoutMax: 1000 });
      expect(result.valid).toBe(false);
    });

    it('should accept timeout at custom minimum bound', () => {
      const manifest = makeValidManifest({ timeout: 300 });
      const result = validateManifest(manifest, { timeoutMin: 300 });
      expect(result.valid).toBe(true);
    });

    it('should accept timeout at custom maximum bound', () => {
      const manifest = makeValidManifest({ timeout: 1000 });
      const result = validateManifest(manifest, { timeoutMax: 1000 });
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
      });
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
      });
      // Should fail due to invalid party_a_address, but not get to hash validation
      expect(result.valid).toBe(false);
      const hashErrors = result.errors.filter((e) => e.message.includes('SHA-256'));
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
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('SHA-256 hash'),
      }));
    });

    it('should detect tampering of manifest fields', () => {
      const manifest = makeValidManifest();
      // Change timeout value, which should invalidate the swap_id
      const result = validateManifest({ ...manifest, timeout: manifest.timeout + 1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
        message: expect.stringContaining('SHA-256 hash'),
      }));
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
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'swap_id',
      }));
    });
  });

  describe('validateManifest - leading-zero rejection', () => {
    it('should reject value "007" with leading zeros', () => {
      const manifest = makeValidManifest({ party_a_value_to_change: '007' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_a_value_to_change',
        message: expect.stringContaining('positive integer'),
      }));
    });

    it('should reject value "0" as not a positive integer', () => {
      const manifest = makeValidManifest({ party_b_value_to_change: '0' });
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        field: 'party_b_value_to_change',
        message: expect.stringContaining('positive integer'),
      }));
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
