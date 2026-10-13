/**
 * Runs the real migration on an in-process Postgres (PGlite) with a minimal
 * stand-in for Supabase's `auth` schema, then checks row-level security.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(fileURLToPath(new URL("../../supabase/migrations/20261013000000_init.sql", import.meta.url)), "utf8");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;");
  }
}

const insertSql = (decision = "CALL") => `insert into public.signal_records
  (source, pair, market_type, analysis_kind, decision, engine_decision, agreement_score, rule_version)
  values ('Twelve Data', 'EUR/USD', 'LIVE', 'LIVE_FEED', '${decision}', '${decision}', 0.5, 'rules-v1') returning id`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  await db.exec(MIGRATION);
  // Supabase grants table privileges to these roles by default; RLS is what restricts rows.
  await db.exec(`
    grant select, insert, update, delete on public.signal_records, public.user_settings, public.audit_logs to authenticated;
    grant usage on all sequences in schema public to authenticated;
  `);
}, 60_000);

describe("RLS on signal_records", () => {
  it("a user sees and edits only their own rows", async () => {
    const id = await as(A, async () => (await db.query<{ id: string }>(insertSql())).rows[0].id);
    const seenByB = await as(B, async () => (await db.query("select * from public.signal_records")).rows.length);
    expect(seenByB).toBe(0);
    const seenByA = await as(A, async () => (await db.query("select user_id from public.signal_records")).rows);
    expect(seenByA).toEqual([{ user_id: A }]);
    const updatedByB = await as(B, async () => (await db.query(`update public.signal_records set outcome='WIN', resolved_at=now() where id='${id}'`)).affectedRows);
    expect(updatedByB).toBe(0);
    const deletedByB = await as(B, async () => (await db.query(`delete from public.signal_records where id='${id}'`)).affectedRows);
    expect(deletedByB).toBe(0);
  });

  it("cannot insert rows for another user", async () => {
    await expect(as(B, () => db.query(insertSql().replace("(source,", "(user_id, source,").replace("values (", `values ('${A}', `)))).rejects.toThrow(/row-level security/);
  });

  it("anonymous requests get nothing", async () => {
    await db.exec("set role anon;");
    await expect(db.query("select * from public.signal_records")).rejects.toThrow(/permission denied/);
    await db.exec("reset role;");
  });

  it("outcome can be recorded, but signal evidence is immutable", async () => {
    await as(A, async () => {
      const id = (await db.query<{ id: string }>(insertSql("PUT"))).rows[0].id;
      const ok = await db.query(`update public.signal_records set outcome='LOSS', resolved_at=now() where id='${id}'`);
      expect(ok.affectedRows).toBe(1);
      await expect(db.query(`update public.signal_records set decision='CALL', engine_decision='CALL' where id='${id}'`)).rejects.toThrow(/immutable/);
    });
  });

  it("NO_TRADE rows cannot be given a win/loss", async () => {
    await as(A, async () => {
      const id = (await db.query<{ id: string }>(insertSql("NO_TRADE"))).rows[0].id;
      await expect(db.query(`update public.signal_records set outcome='WIN', resolved_at=now() where id='${id}'`)).rejects.toThrow(/outcome_needs_trade/);
    });
  });

  it("rejects non-demo records and invalid enums", async () => {
    await as(A, async () => {
      await expect(db.query(insertSql().replace("'LIVE',", "'CRYPTO',"))).rejects.toThrow(/check constraint/);
      await expect(db.query(`insert into public.signal_records (source, pair, market_type, analysis_kind, decision, engine_decision, agreement_score, rule_version, is_demo)
        values ('x1', 'EUR/USD', 'LIVE', 'LIVE_FEED', 'CALL', 'CALL', 0.1, 'v', false)`)).rejects.toThrow(/check constraint/);
    });
  });
});

describe("audit_logs is append-only", () => {
  it("users can insert and read their own entries but not change or delete them", async () => {
    await as(A, () => db.query("insert into public.audit_logs (action) values ('journal.create')"));
    const bSees = await as(B, async () => (await db.query("select * from public.audit_logs")).rows.length);
    expect(bSees).toBe(0);
    const upd = await as(A, async () => (await db.query("update public.audit_logs set action='tampered'")).affectedRows);
    expect(upd).toBe(0);
    const del = await as(A, async () => (await db.query("delete from public.audit_logs")).affectedRows);
    expect(del).toBe(0);
    const aSees = await as(A, async () => (await db.query<{ action: string }>("select action from public.audit_logs")).rows);
    expect(aSees).toEqual([{ action: "journal.create" }]);
  });
});
