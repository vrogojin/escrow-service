const DIRECT_PREFIX = 'DIRECT://';
const PROXY_PREFIX = 'PROXY://';
const NAMETAG_PREFIX = '@';

export type AddressType = 'DIRECT' | 'PROXY' | 'NAMETAG';

export interface ParsedAddress {
  type: AddressType;
  raw: string;
  value: string; // the part after the prefix
}

/**
 * Parse a Sphere address string into its components.
 */
export function parseAddress(address: string): ParsedAddress | null {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();

  if (trimmed.startsWith(DIRECT_PREFIX) && trimmed.length > DIRECT_PREFIX.length) {
    return { type: 'DIRECT', raw: trimmed, value: trimmed.slice(DIRECT_PREFIX.length) };
  }
  if (trimmed.startsWith(PROXY_PREFIX) && trimmed.length > PROXY_PREFIX.length) {
    return { type: 'PROXY', raw: trimmed, value: trimmed.slice(PROXY_PREFIX.length) };
  }
  if (trimmed.startsWith(NAMETAG_PREFIX) && trimmed.length > NAMETAG_PREFIX.length) {
    return { type: 'NAMETAG', raw: trimmed, value: trimmed.slice(NAMETAG_PREFIX.length) };
  }
  return null;
}

/**
 * Validate that a string is a valid Sphere address.
 */
export function isValidAddress(address: string): boolean {
  return parseAddress(address) !== null;
}

/**
 * Normalize address for comparison (case-insensitive for DIRECT/PROXY hex, lowercase for nametags).
 */
export function normalizeAddress(address: string): string {
  const parsed = parseAddress(address);
  if (!parsed) return address;

  switch (parsed.type) {
    case 'DIRECT':
      return `DIRECT://${parsed.value.toLowerCase()}`;
    case 'PROXY':
      return `PROXY://${parsed.value.toLowerCase()}`;
    case 'NAMETAG':
      return `@${parsed.value.toLowerCase()}`;
  }
}

/**
 * Check if two addresses refer to the same destination.
 */
export function addressesMatch(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
