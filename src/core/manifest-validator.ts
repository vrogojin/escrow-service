/**
 * Manifest validation for the escrow service.
 *
 * Types (SwapManifest, ManifestFields) and core functions (computeSwapId,
 * validateManifest) are imported from sphere-sdk — the single source of truth.
 *
 * This module re-exports them and adds escrow-specific validation if needed.
 */
export { validateManifest, verifyManifestIntegrity } from '@unicitylabs/sphere-sdk';
export type { SwapManifest, ManifestFields } from '@unicitylabs/sphere-sdk';
