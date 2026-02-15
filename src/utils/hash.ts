import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import canonicalize from 'canonicalize';
const serialize = canonicalize as unknown as (input: unknown) => string | undefined;

export interface ManifestFields {
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
}

/**
 * Compute swap_id as SHA-256 of RFC 8785 canonical JSON of all manifest fields (excluding swap_id).
 */
export function computeSwapId(fields: ManifestFields): string {
  const canonical = serialize(fields);
  if (!canonical) {
    throw new Error('Failed to canonicalize manifest fields');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validate that a string is exactly 64 hex characters.
 */
export function isValidSwapId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}
