import { computeSwapId, isValidSwapId, type ManifestFields } from '../utils/hash.js';
import { isValidAddress, normalizeAddress } from '../utils/address.js';

export interface SwapManifest {
  swap_id: string;
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate that a string is a valid positive bigint (no decimals, no negatives, no zero).
 */
function isValidPositiveBigint(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  try {
    const n = BigInt(value);
    return n > 0n;
  } catch {
    return false;
  }
}

export function validateManifest(
  manifest: unknown,
  options?: { timeoutMin?: number; timeoutMax?: number },
): ValidationResult {
  const errors: ValidationError[] = [];
  const timeoutMin = options?.timeoutMin ?? 60;
  const timeoutMax = options?.timeoutMax ?? 86400;

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: [{ field: 'manifest', message: 'Must be a non-null object' }] };
  }

  const m = manifest as Record<string, unknown>;

  // swap_id
  if (typeof m.swap_id !== 'string' || !isValidSwapId(m.swap_id)) {
    errors.push({ field: 'swap_id', message: 'Must be exactly 64 lowercase hex characters' });
  }

  // party_a_address
  if (typeof m.party_a_address !== 'string' || !isValidAddress(m.party_a_address)) {
    errors.push({ field: 'party_a_address', message: 'Must be a valid Sphere address (DIRECT://, PROXY://, or @nametag)' });
  }

  // party_b_address
  if (typeof m.party_b_address !== 'string' || !isValidAddress(m.party_b_address)) {
    errors.push({ field: 'party_b_address', message: 'Must be a valid Sphere address (DIRECT://, PROXY://, or @nametag)' });
  }

  // addresses must differ (normalize before comparing to catch case-variation self-swaps)
  if (
    typeof m.party_a_address === 'string' &&
    typeof m.party_b_address === 'string' &&
    normalizeAddress(m.party_a_address) === normalizeAddress(m.party_b_address)
  ) {
    errors.push({ field: 'party_b_address', message: 'Must differ from party_a_address' });
  }

  // party_a_currency_to_change
  if (typeof m.party_a_currency_to_change !== 'string' || m.party_a_currency_to_change.length === 0) {
    errors.push({ field: 'party_a_currency_to_change', message: 'Must be a non-empty string' });
  }

  // party_b_currency_to_change
  if (typeof m.party_b_currency_to_change !== 'string' || m.party_b_currency_to_change.length === 0) {
    errors.push({ field: 'party_b_currency_to_change', message: 'Must be a non-empty string' });
  }

  // currencies must differ
  if (
    typeof m.party_a_currency_to_change === 'string' &&
    typeof m.party_b_currency_to_change === 'string' &&
    m.party_a_currency_to_change === m.party_b_currency_to_change
  ) {
    errors.push({ field: 'party_b_currency_to_change', message: 'Must differ from party_a_currency_to_change' });
  }

  // party_a_value_to_change
  if (typeof m.party_a_value_to_change !== 'string' || !isValidPositiveBigint(m.party_a_value_to_change)) {
    errors.push({ field: 'party_a_value_to_change', message: 'Must be a valid positive integer string' });
  }

  // party_b_value_to_change
  if (typeof m.party_b_value_to_change !== 'string' || !isValidPositiveBigint(m.party_b_value_to_change)) {
    errors.push({ field: 'party_b_value_to_change', message: 'Must be a valid positive integer string' });
  }

  // timeout
  if (typeof m.timeout !== 'number' || !Number.isInteger(m.timeout) || m.timeout < timeoutMin || m.timeout > timeoutMax) {
    errors.push({ field: 'timeout', message: `Must be an integer between ${timeoutMin} and ${timeoutMax}` });
  }

  // Verify swap_id = hash of other fields (only if all other fields are valid types)
  if (errors.length === 0) {
    const fields: ManifestFields = {
      party_a_address: m.party_a_address as string,
      party_b_address: m.party_b_address as string,
      party_a_currency_to_change: m.party_a_currency_to_change as string,
      party_a_value_to_change: m.party_a_value_to_change as string,
      party_b_currency_to_change: m.party_b_currency_to_change as string,
      party_b_value_to_change: m.party_b_value_to_change as string,
      timeout: m.timeout as number,
    };
    const expectedId = computeSwapId(fields);
    if (m.swap_id !== expectedId) {
      errors.push({ field: 'swap_id', message: 'Does not match SHA-256 hash of manifest fields' });
    }
  }

  return { valid: errors.length === 0, errors };
}
