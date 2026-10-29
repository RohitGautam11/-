/**
 * Shows exactly what the server stores for chats — useful to verify that nothing is readable.
 *   DATABASE_URL=postgres://… node scripts/inspect-db.mts     (or no env for the local embedded DB;
 *   stop `npm run dev` first, the embedded DB allows one process at a time)
 */
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

type Q = (sql: string) => Promise<Record<string, unknown>[]>;
let q: Q;
let close: () => Promise<void>;
if (url) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  q = async (sql) => (await client.query(sql)).rows;
  close = () => client.end();
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(process.env.PGLITE_DIR ?? ".data/pglite");
  q = async (sql) => (await db.query<Record<string, unknown>>(sql)).rows;
  close = () => db.close();
}

const cut = (v: unknown, n = 48) => (typeof v === "string" && v.length > n ? `${v.slice(0, n)}… (${v.length} chars)` : v);
const show = (title: string, rows: Record<string, unknown>[]) => {
  console.log(`\n── ${title} ──`);
  console.table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v)]))));
};

show("messages (latest 8)", await q(
  "SELECT kind, epoch, ciphertext, system_text, reveal_at IS NOT NULL AS capsule, deleted_at IS NOT NULL AS deleted FROM messages ORDER BY created_at DESC LIMIT 8",
));
show("conversations", await q("SELECT kind, key_epoch, encrypted_meta FROM conversations ORDER BY created_at DESC LIMIT 5"));
show("wrapped conversation keys", await q("SELECT epoch, wrapped_key FROM conversation_keys ORDER BY created_at DESC LIMIT 5"));
show("users", await q("SELECT username, auth_hash, encrypted_private_key FROM users ORDER BY created_at DESC LIMIT 5"));
show("chat attachments", await q("SELECT content_type, size, encode(substring(data from 1 for 16), 'hex') AS first_bytes FROM blobs WHERE NOT is_public LIMIT 5"));
await close();
