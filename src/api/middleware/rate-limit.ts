import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter. No extra dependencies.
 * Limits requests per IP per minute window.
 */
export function createRateLimiter(maxPerMinute: number) {
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every 60 seconds
  const cleanupHandle = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 60_000);
  cleanupHandle.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const windowMs = 60_000;

    let entry = store.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', maxPerMinute);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxPerMinute - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxPerMinute) {
      res.status(429).json({
        error: 'Too many requests. Please try again later.',
      });
      return;
    }

    next();
  };
}
