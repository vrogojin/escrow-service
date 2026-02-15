import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;
export type { Pool, PoolClient } from 'pg';

let pool: pg.Pool | null = null;

export function getPool(databaseUrl?: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl ?? process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run the database schema migration.
 */
export async function migrate(databaseUrl?: string): Promise<void> {
  const p = getPool(databaseUrl);
  await p.query(SCHEMA_SQL);
  logger.info('Database migration completed');
}

/**
 * Run a callback within a database transaction. Handles BEGIN/COMMIT/ROLLBACK automatically.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS swap_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swap_id VARCHAR(64) NOT NULL UNIQUE,
  manifest JSONB NOT NULL,
  state VARCHAR(50) NOT NULL DEFAULT 'ANNOUNCED'
    CHECK (state IN ('ANNOUNCED','PARTIAL_DEPOSIT','READY_TO_CONCLUDE','CONCLUDING','COMPLETED','TIMED_OUT','REFUNDING','REFUNDED','FAILED')),

  party_a_deposited VARCHAR(100) NOT NULL DEFAULT '0',
  party_b_deposited VARCHAR(100) NOT NULL DEFAULT '0',
  party_a_coin_id VARCHAR(64),
  party_b_coin_id VARCHAR(64),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_deposit_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_swap_state ON swap_cases(state);
CREATE INDEX IF NOT EXISTS idx_swap_timeout ON swap_cases(timeout_at)
  WHERE state = 'PARTIAL_DEPOSIT' AND timeout_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swap_swap_id ON swap_cases(swap_id);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swap_id VARCHAR(64) NOT NULL REFERENCES swap_cases(swap_id) ON DELETE CASCADE,
  transaction_id VARCHAR(128) NOT NULL UNIQUE,

  sender VARCHAR(200) NOT NULL,
  amount VARCHAR(100) NOT NULL,
  coin_id VARCHAR(64) NOT NULL,
  memo TEXT NOT NULL,
  matched_party CHAR(1) CHECK (matched_party IN ('A','B')),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSED')),

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deposits_swap_id ON deposits(swap_id);

CREATE TABLE IF NOT EXISTS transaction_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swap_id VARCHAR(64) NOT NULL REFERENCES swap_cases(swap_id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL
    CHECK (type IN ('DEPOSIT','BOUNCEBACK','CROSS_PAYMENT','SURPLUS_RETURN','REFUND')),
  direction VARCHAR(10) NOT NULL
    CHECK (direction IN ('INCOMING','OUTGOING')),

  sender VARCHAR(200) NOT NULL,
  recipient VARCHAR(200) NOT NULL,
  amount VARCHAR(100) NOT NULL,
  coin_id VARCHAR(64) NOT NULL,
  memo TEXT,

  transaction_id VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENT','CONFIRMED','FAILED')),
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_txlogs_swap_id ON transaction_logs(swap_id);
CREATE INDEX IF NOT EXISTS idx_txlogs_type ON transaction_logs(type);
CREATE INDEX IF NOT EXISTS idx_txlogs_composite ON transaction_logs(swap_id, type, created_at);
`;
