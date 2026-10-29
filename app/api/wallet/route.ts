import { requireUser } from "@/lib/server/auth";
import { one, query } from "@/lib/server/db";
import { json, route } from "@/lib/server/http";
import { testMoneyEnabled } from "@/lib/server/wallet";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const wallet = await one<{ balance_paise: number }>("SELECT balance_paise FROM wallets WHERE user_id = $1", [user.id]);
  const entries = await query<{
    id: number; transfer_id: string; amount_paise: number; balance_after: number; created_at: Date; kind: string;
    conversation_id: string | null; counterparty_id: string | null; counterparty_name: string | null; counterparty_username: string | null;
  }>(
    `SELECT l.id, l.transfer_id, l.amount_paise, l.balance_after, l.created_at, t.kind, t.conversation_id,
            cp.id AS counterparty_id, cp.display_name AS counterparty_name, cp.username AS counterparty_username
       FROM ledger_entries l
       JOIN transfers t ON t.id = l.transfer_id
       LEFT JOIN users cp ON cp.id = CASE WHEN t.from_user = $1 THEN t.to_user ELSE t.from_user END
      WHERE l.user_id = $1
      ORDER BY l.id DESC LIMIT 100`,
    [user.id],
  );
  const pending = await query<{ id: string; conversation_id: string; amount_paise: number; requester_name: string; created_at: Date }>(
    `SELECT r.id, r.conversation_id, r.amount_paise, u.display_name AS requester_name, r.created_at
       FROM payment_requests r JOIN users u ON u.id = r.requester_id
      WHERE r.payer_id = $1 AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 50`,
    [user.id],
  );
  return json({
    balance: wallet?.balance_paise ?? 0,
    testMode: testMoneyEnabled(),
    entries: entries.map((e) => ({
      id: e.id,
      transferId: e.transfer_id,
      amount: e.amount_paise,
      balanceAfter: e.balance_after,
      createdAt: e.created_at,
      kind: e.kind,
      conversationId: e.conversation_id,
      counterparty: e.counterparty_id
        ? { id: e.counterparty_id, displayName: e.counterparty_name, username: e.counterparty_username }
        : null,
    })),
    pendingRequests: pending.map((p) => ({
      id: p.id, conversationId: p.conversation_id, amount: p.amount_paise, requesterName: p.requester_name, createdAt: p.created_at,
    })),
  });
});
