import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export type QueryResult<T> = { rows: T[] };
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

type Driver = {
  query: Queryable["query"];
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
};

const globalForDb = globalThis as unknown as { __vartalapDb?: Promise<Driver> };

async function createPgDriver(url: string): Promise<Driver> {
  const pg = await import("pg");
  // int8 / numeric come back as strings by default; every bigint we store fits in a JS number.
  pg.default.types.setTypeParser(20, (v) => Number(v));
  pg.default.types.setTypeParser(1700, (v) => Number(v));
  const pool = new pg.default.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return {
    query: async (text, params) => pool.query(text, params as unknown[]) as never,
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (t, p) => client.query(t, p as unknown[]) as never });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function createPgliteDriver(): Promise<Driver> {
  if (process.env.VERCEL || (process.env.NODE_ENV === "production" && !process.env.ALLOW_EMBEDDED_DB)) {
    throw new Error("DATABASE_URL is not set. Add a Postgres connection string (e.g. Neon) to the environment.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR ?? ".data/pglite";
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  // PGlite runs in-process and is single-connection, so serialise transactions.
  let chain: Promise<unknown> = Promise.resolve();
  const toNumber = <T>(rows: T[]) => rows.map((row) => {
    const out = row as Record<string, unknown>;
    for (const key in out) if (typeof out[key] === "bigint") out[key] = Number(out[key]);
    return row;
  });
  return {
    query: async (text, params) => {
      await chain.catch(() => undefined);
      const res = await db.query(text, params as unknown[]);
      return { rows: toNumber(res.rows) } as never;
    },
    exec: async (sql) => {
      await db.exec(sql);
    },
    tx: (fn) => {
      const run = chain.catch(() => undefined).then(() => db.transaction((t) => fn({
        query: async (text, params) => {
          const res = await t.query(text, params as unknown[]);
          return { rows: toNumber(res.rows) } as never;
        },
      })));
      chain = run;
      return run;
    },
  };
}

async function init(): Promise<Driver> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const driver = url ? await createPgDriver(url) : await createPgliteDriver();
  await migrate(driver);
  return driver;
}

async function migrate(driver: Driver) {
  await driver.exec("CREATE TABLE IF NOT EXISTS app_meta (key text PRIMARY KEY, value text NOT NULL)");
  const current = await driver.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema_version'");
  if (Number(current.rows[0]?.value ?? 0) >= SCHEMA_VERSION) return;
  // Several cold-starting instances may race here; the advisory lock makes the migration run once.
  await driver.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(727274)");
    const again = await q.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema_version'");
    if (Number(again.rows[0]?.value ?? 0) >= SCHEMA_VERSION) return;
    for (const statement of SCHEMA_SQL) await q.query(statement);
    await q.query(
      "INSERT INTO app_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [String(SCHEMA_VERSION)],
    );
  });
}

function driver(): Promise<Driver> {
  if (!globalForDb.__vartalapDb) {
    globalForDb.__vartalapDb = init().catch((error) => {
      globalForDb.__vartalapDb = undefined;
      throw error;
    });
  }
  return globalForDb.__vartalapDb;
}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = await driver();
  return (await db.query<T>(text, params)).rows;
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query<T>(text, params))[0];
}

export async function tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const db = await driver();
  return db.tx(fn);
}
