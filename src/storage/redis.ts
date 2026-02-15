import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

export type { Redis } from 'ioredis';

let redisClient: Redis | null = null;

export function getRedis(redisUrl?: string): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redisClient.on('error', (err: Error) => {
      logger.error({ err }, 'Redis connection error');
    });
    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return redisClient;
}

export async function connectRedis(redisUrl?: string): Promise<Redis> {
  const client = getRedis(redisUrl);
  await client.connect();
  return client;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Acquire a distributed lock using Redis SET NX EX.
 * Returns a release function on success, or null if lock not acquired.
 */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<(() => Promise<void>) | null> {
  const lockKey = `lock:${key}`;
  const lockValue = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);

  const result = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
  if (result !== 'OK') {
    return null;
  }

  return async () => {
    // Only release if we still own the lock (compare-and-delete via Lua)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, lockKey, lockValue);
  };
}
