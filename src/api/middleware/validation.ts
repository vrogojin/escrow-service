import type { Request, Response, NextFunction } from 'express';
import { isValidSwapId } from '../../utils/hash.js';

/**
 * Validate that :swap_id param is a valid 64-hex-char swap ID.
 */
export function validateSwapIdParam(req: Request, res: Response, next: NextFunction): void {
  const swapId = req.params.swap_id as string | undefined;
  if (!swapId || !isValidSwapId(swapId.toLowerCase())) {
    res.status(400).json({
      error: 'Invalid swap_id: must be exactly 64 lowercase hex characters',
    });
    return;
  }
  req.params.swap_id = swapId.toLowerCase();
  next();
}

/**
 * Validate that the request body contains a manifest object.
 */
export function validateManifestBody(req: Request, res: Response, next: NextFunction): void {
  if (!req.body?.manifest || typeof req.body.manifest !== 'object') {
    res.status(400).json({
      error: 'Request body must contain a "manifest" object',
    });
    return;
  }
  next();
}
