/**
 * Re-export swap manifest types and utilities from sphere-sdk.
 * The SDK is the single source of truth for all data types and methods.
 */
export { computeSwapId, validateManifest, verifyManifestIntegrity } from '@unicitylabs/sphere-sdk';
export type { ManifestFields, SwapManifest } from '@unicitylabs/sphere-sdk';

/**
 * Validate that a string is exactly 64 hex characters.
 */
export function isValidSwapId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}
