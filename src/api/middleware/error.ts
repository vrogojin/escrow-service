import type { Request, Response, NextFunction } from 'express';
import { ManifestValidationError, SwapLimitError } from '../../core/swap-manager.js';
import { logger } from '../../utils/logger.js';

export interface ApiError {
  status: number;
  error: string;
  details?: unknown;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ManifestValidationError) {
    res.status(400).json({
      error: 'Manifest validation failed',
      details: err.errors,
    });
    return;
  }

  if (err instanceof SwapLimitError) {
    res.status(429).json({
      error: err.message,
    });
    return;
  }

  // Check for PostgreSQL unique constraint violation (duplicate swap_id)
  if ((err as any).code === '23505') {
    res.status(409).json({
      error: 'Swap already exists',
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error',
  });
}
