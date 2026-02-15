import type { Pool } from 'pg';
import { SwapState } from './state-machine.js';
import { validateManifest, type SwapManifest } from './manifest-validator.js';
import { SwapRepository, type SwapCaseRow } from '../storage/repositories/swap.repository.js';
import { DepositRepository } from '../storage/repositories/deposit.repository.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../config.js';

export interface SwapManagerDeps {
  pool: Pool;
  swapRepo: SwapRepository;
  depositRepo: DepositRepository;
  config: Config;
}

export interface AnnounceResult {
  swapCase: SwapCaseRow;
  isNew: boolean;
}

export class SwapManager {
  private swapRepo: SwapRepository;
  private config: Config;
  private pool: Pool;

  constructor(deps: SwapManagerDeps) {
    this.swapRepo = deps.swapRepo;
    this.config = deps.config;
    this.pool = deps.pool;
  }

  /**
   * Submit (announce) a swap manifest. Returns existing case on duplicate.
   */
  async announceSwap(manifest: SwapManifest): Promise<AnnounceResult> {
    // Validate manifest
    const validation = validateManifest(manifest, {
      timeoutMin: this.config.swapTimeoutMin,
      timeoutMax: this.config.swapTimeoutMax,
    });
    if (!validation.valid) {
      throw new ManifestValidationError(validation.errors);
    }

    // Check pending swap limit
    const pendingCount = await this.swapRepo.countPending();
    if (pendingCount >= this.config.maxPendingSwaps) {
      throw new SwapLimitError(`Maximum pending swaps limit reached (${this.config.maxPendingSwaps})`);
    }

    // Try to create; handle duplicate
    const existing = await this.swapRepo.findBySwapId(manifest.swap_id);
    if (existing) {
      return { swapCase: existing, isNew: false };
    }

    const swapCase = await this.swapRepo.create(manifest);
    logger.info({ swap_id: manifest.swap_id }, 'Swap announced');
    return { swapCase, isNew: true };
  }

  /**
   * Get swap case by swap_id.
   */
  async getSwap(swapId: string): Promise<SwapCaseRow | null> {
    return this.swapRepo.findBySwapId(swapId);
  }

  /**
   * Transition a swap to FAILED state.
   */
  async markFailed(swapId: string, errorMessage: string): Promise<void> {
    const swap = await this.swapRepo.findBySwapId(swapId);
    if (!swap) return;

    await this.swapRepo.updateState(
      swapId,
      SwapState.FAILED,
      swap.version,
      { error_message: errorMessage },
    );

    logger.error({ swap_id: swapId, error: errorMessage }, 'Swap marked as FAILED');
  }
}

export class ManifestValidationError extends Error {
  constructor(public readonly errors: Array<{ field: string; message: string }>) {
    super(`Manifest validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join(', ')}`);
    this.name = 'ManifestValidationError';
  }
}

export class SwapLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapLimitError';
  }
}
