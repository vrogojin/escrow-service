export interface Config {
  port: number;
  nodeEnv: string;
  logLevel: string;

  databaseUrl: string;
  redisUrl: string;

  sphereWalletPath: string;
  sphereAddressIndex: number;
  sphereNetwork: string;

  swapTimeoutMin: number;
  swapTimeoutMax: number;
  swapTimeoutDefault: number;

  paymentRetryMaxAttempts: number;
  paymentRetryDelayMs: number;

  rateLimitManifestPerMinute: number;
  maxPendingSwaps: number;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',

    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/escrow_db',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

    sphereWalletPath: process.env.SPHERE_WALLET_PATH ?? './.sphere-escrow',
    sphereAddressIndex: parseInt(process.env.SPHERE_ADDRESS_INDEX ?? '0', 10),
    sphereNetwork: process.env.SPHERE_NETWORK ?? 'mainnet',

    swapTimeoutMin: parseInt(process.env.SWAP_TIMEOUT_MIN ?? '60', 10),
    swapTimeoutMax: parseInt(process.env.SWAP_TIMEOUT_MAX ?? '86400', 10),
    swapTimeoutDefault: parseInt(process.env.SWAP_TIMEOUT_DEFAULT ?? '3600', 10),

    paymentRetryMaxAttempts: parseInt(process.env.PAYMENT_RETRY_MAX_ATTEMPTS ?? '3', 10),
    paymentRetryDelayMs: parseInt(process.env.PAYMENT_RETRY_DELAY_MS ?? '5000', 10),

    rateLimitManifestPerMinute: parseInt(process.env.RATE_LIMIT_MANIFEST_PER_MINUTE ?? '10', 10),
    maxPendingSwaps: parseInt(process.env.MAX_PENDING_SWAPS ?? '10000', 10),
  };
}
