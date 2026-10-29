import { randomUUID } from "node:crypto";
import type { Queryable } from "./db";
import { ApiError } from "./http";

export const SIGNUP_BONUS_PAISE = Number(process.env.WALLET_SIGNUP_BONUS_PAISE ?? 100_000);
export const MAX_TRANSFER_PAISE = Number(process.env.WALLET_MAX_TRANSFER_PAISE ?? 10_000_000);
export const testMoneyEnabled = () => process.env.WALLET_TEST_MODE !== "off";

async function ensureWallet(q: Queryable, userId: string) {
  await q.query("INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
}

/** Credits money that enters the system (sign-up bonus, test top-ups). Must run inside a transaction. */
export async function credit(q: Queryable, userId: string, amount: number, kind: "topup" | "bonus") {
  await ensureWallet(q, userId);
  const transferId = randomUUID();
  await q.query(
    "INSERT INTO transfers (id, from_user, to_user, amount_paise, kind) VALUES ($1, NULL, $2, $3, $4)",
    [transferId, userId, amount, kind],
  );
  const { rows } = await q.query<{ balance_paise: number }>(
    "UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = now() WHERE user_id = $1 RETURNING balance_paise",
    [userId, amount],
  );
  await q.query(
    "INSERT INTO ledger_entries (transfer_id, user_id, amount_paise, balance_after) VALUES ($1, $2, $3, $4)",
    [transferId, userId, amount, rows[0].balance_paise],
  );
  return transferId;
}

type TransferInput = {
  from: string;
  to: string;
  amount: number;
  idempotencyKey: string;
  conversationId?: string | null;
  requestId?: string | null;
};

/**
 * Moves money between two wallets atomically. Must run inside a transaction.
 * Returns the existing transfer when the same idempotency key is replayed.
 */
export async function transfer(q: Queryable, input: TransferInput): Promise<{ id: string; replayed: boolean }> {
  if (input.from === input.to) throw new ApiError(400, "You cannot send money to yourself.");
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new ApiError(400, "Enter a valid amount.");
  if (input.amount > MAX_TRANSFER_PAISE) throw new ApiError(400, "This amount is above the per-transfer limit.");

  const existing = await q.query<{ id: string }>(
    "SELECT id FROM transfers WHERE from_user = $1 AND idempotency_key = $2",
    [input.from, input.idempotencyKey],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, replayed: true };

  await ensureWallet(q, input.from);
  await ensureWallet(q, input.to);
  // Lock both rows in a stable order so concurrent opposite transfers cannot deadlock.
  const locked = await q.query<{ user_id: string; balance_paise: number }>(
    "SELECT user_id, balance_paise FROM wallets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE",
    [[input.from, input.to]],
  );
  const sender = locked.rows.find((row) => row.user_id === input.from);
  if (!sender || sender.balance_paise < input.amount) throw new ApiError(400, "Not enough balance for this payment.", "insufficient_funds");

  const id = randomUUID();
  await q.query(
    `INSERT INTO transfers (id, from_user, to_user, amount_paise, kind, conversation_id, request_id, idempotency_key)
     VALUES ($1, $2, $3, $4, 'transfer', $5, $6, $7)`,
    [id, input.from, input.to, input.amount, input.conversationId ?? null, input.requestId ?? null, input.idempotencyKey],
  );
  const debit = await q.query<{ balance_paise: number }>(
    "UPDATE wallets SET balance_paise = balance_paise - $2, updated_at = now() WHERE user_id = $1 RETURNING balance_paise",
    [input.from, input.amount],
  );
  const creditRow = await q.query<{ balance_paise: number }>(
    "UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = now() WHERE user_id = $1 RETURNING balance_paise",
    [input.to, input.amount],
  );
  await q.query(
    `INSERT INTO ledger_entries (transfer_id, user_id, amount_paise, balance_after)
     VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
    [id, input.from, -input.amount, debit.rows[0].balance_paise, input.to, input.amount, creditRow.rows[0].balance_paise],
  );
  return { id, replayed: false };
}
