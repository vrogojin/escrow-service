import type { Pool, PoolClient } from 'pg';
import type { SwapManifest } from '../../core/manifest-validator.js';
import { type SwapState } from '../../core/state-machine.js';

export interface SwapCaseRow {
  id: string;
  swap_id: string;
  manifest: SwapManifest;
  state: SwapState;
  party_a_deposited: string;
  party_b_deposited: string;
  party_a_coin_id: string | null;
  party_b_coin_id: string | null;
  created_at: Date;
  first_deposit_at: Date | null;
  timeout_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  version: number;
}

export class SwapRepository {
  constructor(private pool: Pool) {}

  async create(manifest: SwapManifest, client?: PoolClient): Promise<SwapCaseRow> {
    const conn = client ?? this.pool;
    const result = await conn.query<SwapCaseRow>(
      `INSERT INTO swap_cases (swap_id, manifest, state)
       VALUES ($1, $2, 'ANNOUNCED')
       RETURNING *`,
      [manifest.swap_id, JSON.stringify(manifest)],
    );
    return result.rows[0];
  }

  async findBySwapId(swapId: string, client?: PoolClient): Promise<SwapCaseRow | null> {
    const conn = client ?? this.pool;
    const result = await conn.query<SwapCaseRow>(
      'SELECT * FROM swap_cases WHERE swap_id = $1',
      [swapId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lock the swap row for update within a transaction.
   */
  async findBySwapIdForUpdate(swapId: string, client: PoolClient): Promise<SwapCaseRow | null> {
    const result = await client.query<SwapCaseRow>(
      'SELECT * FROM swap_cases WHERE swap_id = $1 FOR UPDATE',
      [swapId],
    );
    return result.rows[0] ?? null;
  }

  async updateState(
    swapId: string,
    newState: SwapState,
    expectedVersion: number,
    updates: Partial<{
      party_a_deposited: string;
      party_b_deposited: string;
      party_a_coin_id: string;
      party_b_coin_id: string;
      first_deposit_at: Date;
      timeout_at: Date;
      completed_at: Date;
      error_message: string;
    }>,
    client?: PoolClient,
  ): Promise<SwapCaseRow | null> {
    const conn = client ?? this.pool;
    const setClauses = ['state = $2', 'version = version + 1'];
    const values: unknown[] = [swapId, newState];
    let paramIndex = 3;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    values.push(expectedVersion);

    const result = await conn.query<SwapCaseRow>(
      `UPDATE swap_cases SET ${setClauses.join(', ')}
       WHERE swap_id = $1 AND version = $${paramIndex}
       RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Update deposit amounts without changing state.
   */
  async updateDeposits(
    swapId: string,
    updates: Partial<{
      party_a_deposited: string;
      party_b_deposited: string;
      party_a_coin_id: string;
      party_b_coin_id: string;
    }>,
    expectedVersion: number,
    client?: PoolClient,
  ): Promise<SwapCaseRow | null> {
    const conn = client ?? this.pool;
    const setClauses = ['version = version + 1'];
    const values: unknown[] = [swapId];
    let paramIndex = 2;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    values.push(expectedVersion);

    const result = await conn.query<SwapCaseRow>(
      `UPDATE swap_cases SET ${setClauses.join(', ')}
       WHERE swap_id = $1 AND version = $${paramIndex}
       RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Update state on a row that is already locked via SELECT FOR UPDATE.
   * Skips version check since the row lock prevents concurrent modification.
   */
  async updateStateWithLock(
    swapId: string,
    newState: SwapState,
    updates: Partial<{
      party_a_deposited: string;
      party_b_deposited: string;
      party_a_coin_id: string;
      party_b_coin_id: string;
      first_deposit_at: Date;
      timeout_at: Date;
      completed_at: Date;
      error_message: string;
    }>,
    client: PoolClient,
  ): Promise<SwapCaseRow | null> {
    const setClauses = ['state = $2', 'version = version + 1'];
    const values: unknown[] = [swapId, newState];
    let paramIndex = 3;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    const result = await client.query<SwapCaseRow>(
      `UPDATE swap_cases SET ${setClauses.join(', ')}
       WHERE swap_id = $1
       RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  }

  async findTimedOut(): Promise<SwapCaseRow[]> {
    const result = await this.pool.query<SwapCaseRow>(
      `SELECT * FROM swap_cases
       WHERE state = 'PARTIAL_DEPOSIT' AND timeout_at IS NOT NULL AND timeout_at <= NOW()`,
    );
    return result.rows;
  }

  async findByState(state: SwapState): Promise<SwapCaseRow[]> {
    const result = await this.pool.query<SwapCaseRow>(
      'SELECT * FROM swap_cases WHERE state = $1',
      [state],
    );
    return result.rows;
  }

  async countByState(state: SwapState): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM swap_cases WHERE state = $1',
      [state],
    );
    return parseInt(result.rows[0].count, 10);
  }

  async countPending(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM swap_cases WHERE state IN ('ANNOUNCED', 'PARTIAL_DEPOSIT')`,
    );
    return parseInt(result.rows[0].count, 10);
  }
}
