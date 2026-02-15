import type { Pool, PoolClient } from 'pg';

export interface DepositRow {
  id: string;
  swap_id: string;
  transaction_id: string;
  sender: string;
  amount: string;
  coin_id: string;
  memo: string;
  matched_party: 'A' | 'B' | null;
  status: string;
  received_at: Date;
  processed_at: Date | null;
}

export class DepositRepository {
  constructor(private pool: Pool) {}

  async create(
    deposit: {
      swap_id: string;
      transaction_id: string;
      sender: string;
      amount: string;
      coin_id: string;
      memo: string;
      matched_party: 'A' | 'B' | null;
    },
    client?: PoolClient,
  ): Promise<DepositRow> {
    const conn = client ?? this.pool;
    const result = await conn.query<DepositRow>(
      `INSERT INTO deposits (swap_id, transaction_id, sender, amount, coin_id, memo, matched_party)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        deposit.swap_id,
        deposit.transaction_id,
        deposit.sender,
        deposit.amount,
        deposit.coin_id,
        deposit.memo,
        deposit.matched_party,
      ],
    );
    return result.rows[0];
  }

  async findByTransactionId(transactionId: string, client?: PoolClient): Promise<DepositRow | null> {
    const conn = client ?? this.pool;
    const result = await conn.query<DepositRow>(
      'SELECT * FROM deposits WHERE transaction_id = $1',
      [transactionId],
    );
    return result.rows[0] ?? null;
  }

  async findBySwapId(swapId: string, client?: PoolClient): Promise<DepositRow[]> {
    const conn = client ?? this.pool;
    const result = await conn.query<DepositRow>(
      'SELECT * FROM deposits WHERE swap_id = $1 ORDER BY received_at',
      [swapId],
    );
    return result.rows;
  }

  async markProcessed(id: string, client?: PoolClient): Promise<void> {
    const conn = client ?? this.pool;
    await conn.query(
      `UPDATE deposits SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
      [id],
    );
  }
}
