import type { Pool, PoolClient } from 'pg';

export type TransactionType = 'DEPOSIT' | 'BOUNCEBACK' | 'CROSS_PAYMENT' | 'SURPLUS_RETURN' | 'REFUND';
export type TransactionDirection = 'INCOMING' | 'OUTGOING';
export type TransactionStatus = 'PENDING' | 'SENT' | 'CONFIRMED' | 'FAILED';

export interface TransactionLogRow {
  id: string;
  swap_id: string;
  type: TransactionType;
  direction: TransactionDirection;
  sender: string;
  recipient: string;
  amount: string;
  coin_id: string;
  memo: string | null;
  transaction_id: string | null;
  status: TransactionStatus;
  error_message: string | null;
  created_at: Date;
  confirmed_at: Date | null;
}

export class TransactionRepository {
  constructor(private pool: Pool) {}

  async create(
    entry: {
      swap_id: string;
      type: TransactionType;
      direction: TransactionDirection;
      sender: string;
      recipient: string;
      amount: string;
      coin_id: string;
      memo?: string;
      transaction_id?: string;
      status?: TransactionStatus;
    },
    client?: PoolClient,
  ): Promise<TransactionLogRow> {
    const conn = client ?? this.pool;
    const result = await conn.query<TransactionLogRow>(
      `INSERT INTO transaction_logs (swap_id, type, direction, sender, recipient, amount, coin_id, memo, transaction_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        entry.swap_id,
        entry.type,
        entry.direction,
        entry.sender,
        entry.recipient,
        entry.amount,
        entry.coin_id,
        entry.memo ?? null,
        entry.transaction_id ?? null,
        entry.status ?? 'PENDING',
      ],
    );
    return result.rows[0];
  }

  async updateStatus(
    id: string,
    status: TransactionStatus,
    transactionId?: string,
    errorMessage?: string,
    client?: PoolClient,
  ): Promise<void> {
    const conn = client ?? this.pool;
    const setClauses = ['status = $2'];
    const values: unknown[] = [id, status];
    let paramIndex = 3;

    if (transactionId !== undefined) {
      setClauses.push(`transaction_id = $${paramIndex}`);
      values.push(transactionId);
      paramIndex++;
    }

    if (errorMessage !== undefined) {
      setClauses.push(`error_message = $${paramIndex}`);
      values.push(errorMessage);
      paramIndex++;
    }

    if (status === 'CONFIRMED') {
      setClauses.push(`confirmed_at = NOW()`);
    }

    await conn.query(
      `UPDATE transaction_logs SET ${setClauses.join(', ')} WHERE id = $1`,
      values,
    );
  }

  async findBySwapId(swapId: string): Promise<TransactionLogRow[]> {
    const result = await this.pool.query<TransactionLogRow>(
      'SELECT * FROM transaction_logs WHERE swap_id = $1 ORDER BY created_at',
      [swapId],
    );
    return result.rows;
  }

  async findBySwapIdAndType(swapId: string, type: TransactionType): Promise<TransactionLogRow[]> {
    const result = await this.pool.query<TransactionLogRow>(
      'SELECT * FROM transaction_logs WHERE swap_id = $1 AND type = $2 ORDER BY created_at',
      [swapId, type],
    );
    return result.rows;
  }

  async existsSuccessful(swapId: string, type: TransactionType, recipient: string): Promise<boolean> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM transaction_logs
       WHERE swap_id = $1 AND type = $2 AND recipient = $3 AND status IN ('SENT', 'CONFIRMED')`,
      [swapId, type, recipient],
    );
    return parseInt(result.rows[0].count, 10) > 0;
  }
}
