import {
  parseAddress,
  isValidAddress,
  normalizeAddress,
  addressesMatch,
  AddressType,
  ParsedAddress,
} from '../address.js';

// Valid 64-char lowercase hex for DIRECT:// addresses (secp256k1 pubkey format)
const HEX64_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX64_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const HEX64_UPPER = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';
const HEX64_MIXED = '0123456789AbCdEf0123456789aBcDeF0123456789AbCdEf0123456789aBcDeF';

describe('address utilities', () => {
  describe('parseAddress', () => {
    it('should parse DIRECT:// address and return type DIRECT', () => {
      const result = parseAddress(`DIRECT://${HEX64_A}`);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('DIRECT');
      expect(result?.value).toBe(HEX64_A);
      expect(result?.raw).toBe(`DIRECT://${HEX64_A}`);
    });

    it('should parse PROXY:// address and return type PROXY', () => {
      const result = parseAddress('PROXY://proxy456');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('PROXY');
      expect(result?.value).toBe('proxy456');
      expect(result?.raw).toBe('PROXY://proxy456');
    });

    it('should parse @nametag address and return type NAMETAG', () => {
      const result = parseAddress('@alice');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('NAMETAG');
      expect(result?.value).toBe('alice');
      expect(result?.raw).toBe('@alice');
    });

    it('should handle leading/trailing whitespace by trimming', () => {
      const result = parseAddress(`  DIRECT://${HEX64_A}  `);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('DIRECT');
      expect(result?.value).toBe(HEX64_A);
      expect(result?.raw).toBe(`DIRECT://${HEX64_A}`);
    });

    it('should return null for empty string', () => {
      expect(parseAddress('')).toBeNull();
    });

    it('should return null for null input', () => {
      // @ts-expect-error - intentionally passing null to test behavior
      expect(parseAddress(null)).toBeNull();
    });

    it('should return null for undefined input', () => {
      // @ts-expect-error - intentionally passing undefined to test behavior
      expect(parseAddress(undefined)).toBeNull();
    });

    it('should return null for just DIRECT:// prefix with no value', () => {
      expect(parseAddress('DIRECT://')).toBeNull();
    });

    it('should return null for just PROXY:// prefix with no value', () => {
      expect(parseAddress('PROXY://')).toBeNull();
    });

    it('should return null for just @ nametag prefix with no value', () => {
      expect(parseAddress('@')).toBeNull();
    });

    it('should return null for invalid address format', () => {
      expect(parseAddress('INVALID://something')).toBeNull();
      expect(parseAddress('something')).toBeNull();
      expect(parseAddress('no-prefix-here')).toBeNull();
    });

    it('should accept any non-empty string after DIRECT:// (SDK behavior)', () => {
      // SDK's parseAddress accepts any non-empty value after DIRECT://
      expect(parseAddress('DIRECT://abc123')).not.toBeNull();
      expect(parseAddress(`DIRECT://${HEX64_A}ff`)).not.toBeNull();
      expect(parseAddress(`DIRECT://${HEX64_UPPER}`)).not.toBeNull();
      // Empty value after prefix is still rejected
      expect(parseAddress('DIRECT://')).toBeNull();
    });

    it('should handle special characters in nametag values', () => {
      const result = parseAddress('@user_name-123');
      expect(result?.type).toBe('NAMETAG');
      expect(result?.value).toBe('user_name-123');
    });

    it('should parse addresses with numbers and special chars', () => {
      const result = parseAddress('PROXY://1234567890');
      expect(result?.type).toBe('PROXY');
      expect(result?.value).toBe('1234567890');
    });
  });

  describe('isValidAddress', () => {
    it('should return true for valid DIRECT address', () => {
      expect(isValidAddress(`DIRECT://${HEX64_A}`)).toBe(true);
    });

    it('should return true for valid PROXY address', () => {
      expect(isValidAddress('PROXY://proxy456')).toBe(true);
    });

    it('should return true for valid NAMETAG address', () => {
      expect(isValidAddress('@alice')).toBe(true);
    });

    it('should return false for invalid address format', () => {
      expect(isValidAddress('INVALID://something')).toBe(false);
      expect(isValidAddress('something')).toBe(false);
      expect(isValidAddress('no-prefix-here')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidAddress('')).toBe(false);
    });

    it('should return false for prefix-only addresses', () => {
      expect(isValidAddress('DIRECT://')).toBe(false);
      expect(isValidAddress('PROXY://')).toBe(false);
      expect(isValidAddress('@')).toBe(false);
    });

    it('should return true for addresses with leading/trailing whitespace', () => {
      // parseAddress trims, so these should be valid
      expect(isValidAddress(`  DIRECT://${HEX64_A}  `)).toBe(true);
      expect(isValidAddress('  @alice  ')).toBe(true);
    });

    it('should return true for DIRECT:// with any non-empty value (SDK behavior)', () => {
      // SDK accepts any non-empty string after DIRECT://
      expect(isValidAddress('DIRECT://abc123')).toBe(true);
      expect(isValidAddress(`DIRECT://${HEX64_UPPER}`)).toBe(true);
    });
  });

  describe('normalizeAddress', () => {
    it('should return DIRECT address unchanged (already lowercase)', () => {
      const normalized = normalizeAddress(`DIRECT://${HEX64_A}`);
      expect(normalized).toBe(`DIRECT://${HEX64_A}`);
    });

    it('should lowercase PROXY hex address', () => {
      const normalized = normalizeAddress('PROXY://XYZ789');
      expect(normalized).toBe('PROXY://xyz789');
    });

    it('should lowercase nametag value', () => {
      const normalized = normalizeAddress('@ALICE');
      expect(normalized).toBe('@alice');
    });

    it('should preserve already lowercase DIRECT address', () => {
      const normalized = normalizeAddress(`DIRECT://${HEX64_A}`);
      expect(normalized).toBe(`DIRECT://${HEX64_A}`);
    });

    it('should preserve already lowercase PROXY address', () => {
      const normalized = normalizeAddress('PROXY://xyz789');
      expect(normalized).toBe('PROXY://xyz789');
    });

    it('should preserve already lowercase nametag', () => {
      const normalized = normalizeAddress('@alice');
      expect(normalized).toBe('@alice');
    });

    it('should handle mixed case in PROXY address', () => {
      const normalized = normalizeAddress('PROXY://PrOxY123AbC');
      expect(normalized).toBe('PROXY://proxy123abc');
    });

    it('should handle mixed case in nametag', () => {
      const normalized = normalizeAddress('@AlIcE123');
      expect(normalized).toBe('@alice123');
    });

    it('should return original string for invalid address', () => {
      const invalid = 'INVALID://something';
      const normalized = normalizeAddress(invalid);
      expect(normalized).toBe(invalid);
    });

    it('should return original string for empty input', () => {
      const normalized = normalizeAddress('');
      expect(normalized).toBe('');
    });

    it('should lowercase DIRECT:// with uppercase hex', () => {
      // SDK's normalizeAddress lowercases the value after DIRECT://
      const addr = `DIRECT://${HEX64_UPPER}`;
      const normalized = normalizeAddress(addr);
      expect(normalized).toBe(`DIRECT://${HEX64_UPPER.toLowerCase()}`);
    });

    it('should handle leading/trailing whitespace by trimming first', () => {
      const normalized = normalizeAddress(`  DIRECT://${HEX64_A}  `);
      expect(normalized).toBe(`DIRECT://${HEX64_A}`);
    });
  });

  describe('addressesMatch', () => {
    it('should return true for identical DIRECT addresses', () => {
      const addr = `DIRECT://${HEX64_A}`;
      expect(addressesMatch(addr, addr)).toBe(true);
    });

    it('should return true for identical PROXY addresses', () => {
      const addr = 'PROXY://xyz789';
      expect(addressesMatch(addr, addr)).toBe(true);
    });

    it('should return true for identical NAMETAG addresses', () => {
      const addr = '@alice';
      expect(addressesMatch(addr, addr)).toBe(true);
    });

    it('should return true for same PROXY address with different cases', () => {
      expect(addressesMatch('PROXY://xyz789', 'PROXY://XYZ789')).toBe(true);
    });

    it('should return true for same NAMETAG with different cases', () => {
      expect(addressesMatch('@alice', '@ALICE')).toBe(true);
    });

    it('should return true for mixed case match in PROXY', () => {
      expect(addressesMatch('PROXY://PrOxY123', 'PROXY://proxy123')).toBe(true);
    });

    it('should return false for different DIRECT addresses', () => {
      expect(addressesMatch(`DIRECT://${HEX64_A}`, `DIRECT://${HEX64_B}`)).toBe(false);
    });

    it('should return false for different PROXY addresses', () => {
      expect(addressesMatch('PROXY://xyz789', 'PROXY://xyz790')).toBe(false);
    });

    it('should return false for different NAMETAGs', () => {
      expect(addressesMatch('@alice', '@bob')).toBe(false);
    });

    it('should return false for DIRECT vs PROXY with same hex value', () => {
      expect(addressesMatch(`DIRECT://${HEX64_A}`, `PROXY://${HEX64_A}`)).toBe(false);
    });

    it('should return false for DIRECT vs NAMETAG', () => {
      expect(addressesMatch(`DIRECT://${HEX64_A}`, '@alice')).toBe(false);
    });

    it('should return false for PROXY vs NAMETAG', () => {
      expect(addressesMatch('PROXY://alice', '@alice')).toBe(false);
    });

    it('should handle leading/trailing whitespace in comparison', () => {
      expect(addressesMatch(`  DIRECT://${HEX64_A}  `, `DIRECT://${HEX64_A}`)).toBe(true);
      expect(addressesMatch('@ALICE', '  @alice  ')).toBe(true);
    });

    it('should return false for one valid and one invalid address', () => {
      expect(addressesMatch(`DIRECT://${HEX64_A}`, 'INVALID://abc123')).toBe(false);
    });

    it('should return false for both invalid addresses', () => {
      expect(addressesMatch('INVALID://abc', 'ALSO_INVALID://def')).toBe(false);
    });

    it('should handle empty string comparison', () => {
      expect(addressesMatch('', '')).toBe(true);
      expect(addressesMatch(`DIRECT://${HEX64_A}`, '')).toBe(false);
    });
  });
});
