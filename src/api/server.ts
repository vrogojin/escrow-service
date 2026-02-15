import express from 'express';
import type { Server } from 'http';
import { createSwapRoutes, type SwapRoutesDeps } from './routes/swap.routes.js';
import { errorHandler } from './middleware/error.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../config.js';

export interface ServerDeps extends SwapRoutesDeps {
  config: Config;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      }, 'request');
    });
    next();
  });

  // Rate limiting on manifest submission
  const rateLimiter = createRateLimiter(deps.config.rateLimitManifestPerMinute);
  app.use('/api/v1/swaps', (req, res, next) => {
    if (req.method === 'POST') {
      rateLimiter(req, res, next);
    } else {
      next();
    }
  });

  // Mount routes
  const swapRoutes = createSwapRoutes(deps);
  app.use('/api/v1', swapRoutes);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}

export function startServer(app: express.Express, port: number): Server {
  return app.listen(port, () => {
    logger.info({ port }, 'HTTP server listening');
  });
}
