import { describe, expect, test } from "bun:test";
import { classifyStatements, explainGuard, isReadOnlySql, scrub, splitStatements } from "./classify.ts";

describe("splitStatements", () => {
  test("splits on semicolons", () => {
    expect(splitStatements("select 1; select 2;", "postgres")).toEqual(["select 1", "select 2"]);
  });

  test("ignores semicolons inside string literals", () => {
    expect(splitStatements("select ';' as a", "postgres")).toEqual(["select ';' as a"]);
  });

  test("ignores semicolons inside quoted identifiers", () => {
    expect(splitStatements(`select "a;b" from t`, "postgres")).toEqual([`select "a;b" from t`]);
  });

  test("ignores semicolons inside line comments", () => {
    expect(splitStatements("select 1 -- ; not a split\n, 2", "postgres")).toEqual([
      "select 1 -- ; not a split\n, 2",
    ]);
  });

  test("ignores semicolons inside block comments", () => {
    expect(splitStatements("select /* ; */ 1", "postgres")).toEqual(["select /* ; */ 1"]);
  });

  test("handles postgres dollar quoting", () => {
    const sql = "select $$a;b$$";
    expect(splitStatements(sql, "postgres")).toEqual([sql]);
  });

  test("handles escaped quotes", () => {
    expect(splitStatements("select 'it''s ok; really'", "postgres")).toEqual(["select 'it''s ok; really'"]);
  });

  test("drops trailing empty statements", () => {
    expect(splitStatements("select 1;;  ;", "postgres")).toEqual(["select 1"]);
  });
});

describe("scrub", () => {
  test("removes comments and literals", () => {
    const out = scrub("select 'delete' /* drop */ from t -- update\n", "postgres");
    expect(out).not.toContain("delete");
    expect(out).not.toContain("drop");
    expect(out).not.toContain("update");
    expect(out).toContain("from t");
  });
});

const readOnly = (sql: string, dialect: "postgres" | "mysql" | "sqlite" = "postgres") =>
  isReadOnlySql(sql, dialect).readOnly;

describe("isReadOnlySql — reads", () => {
  test("plain select", () => {
    expect(readOnly("select 1")).toBe(true);
  });

  test("select with joins, group by and limit", () => {
    expect(
      readOnly(`
        select u.email, sum(o.total_cents) as revenue
        from users u join orders o on o.user_id = u.id
        where o.placed_at > now() - interval '30 days'
        group by 1 order by 2 desc limit 25
      `),
    ).toBe(true);
  });

  test("read-only CTE", () => {
    expect(readOnly("with recent as (select * from orders where id > 10) select count(*) from recent")).toBe(true);
  });

  test("multiple selects", () => {
    const r = isReadOnlySql("select 1; select 2; select 3", "postgres");
    expect(r.readOnly).toBe(true);
    expect(r.statements).toBe(3);
  });

  test("comments do not smuggle a false positive", () => {
    expect(readOnly("-- delete from users\nselect 1")).toBe(true);
  });

  test("a string literal containing a write keyword is fine", () => {
    expect(readOnly("select * from events where kind = 'delete'")).toBe(true);
  });

  test("explain analyze select", () => {
    expect(readOnly("explain analyze select * from users")).toBe(true);
  });

  test("show / describe", () => {
    expect(readOnly("show tables", "mysql")).toBe(true);
    expect(readOnly("describe users", "mysql")).toBe(true);
  });

  test("column names that merely start with a keyword", () => {
    expect(readOnly("select created_at, updated_at, deleted_at from users")).toBe(true);
  });

  test("`in` is not `into`", () => {
    expect(readOnly("select * from users where id in (1,2,3)")).toBe(true);
  });
});

describe("isReadOnlySql — writes", () => {
  test("insert", () => {
    expect(readOnly("insert into users (id) values (1)")).toBe(false);
  });

  test("update", () => {
    expect(readOnly("update users set name = 'x'")).toBe(false);
  });

  test("delete", () => {
    expect(readOnly("delete from users")).toBe(false);
  });

  test("CTE wrapping an INSERT", () => {
    const r = isReadOnlySql(
      "with moved as (insert into archive select * from users returning *) select count(*) from moved",
      "postgres",
    );
    expect(r.readOnly).toBe(false);
    expect(r.reason).toBeDefined();
  });

  test("CTE wrapping a DELETE", () => {
    expect(
      readOnly("with gone as (delete from users where id = 1 returning *) select * from gone"),
    ).toBe(false);
  });

  test("select … into", () => {
    expect(readOnly("select * into new_users from users")).toBe(false);
  });

  test("copy", () => {
    expect(readOnly("copy users from '/tmp/users.csv'")).toBe(false);
  });

  test("copy … to stdout is conservatively rejected", () => {
    expect(readOnly("copy (select * from users) to stdout")).toBe(false);
  });

  test("explain analyze delete", () => {
    const r = isReadOnlySql("explain analyze delete from users where id = 1", "postgres");
    expect(r.readOnly).toBe(false);
    expect(r.reason).toContain("DELETE");
  });

  test("a read followed by a write in the same batch", () => {
    const r = isReadOnlySql("select 1; delete from users", "postgres");
    expect(r.readOnly).toBe(false);
    expect(r.statements).toBe(2);
  });

  test("write hidden after a comment", () => {
    expect(readOnly("/* harmless */ truncate table users")).toBe(false);
  });

  test("ddl", () => {
    expect(readOnly("create table t (id int)")).toBe(false);
    expect(readOnly("drop table t")).toBe(false);
    expect(readOnly("alter table t add column x int")).toBe(false);
  });

  test("set / transaction control", () => {
    expect(readOnly("set search_path = public")).toBe(false);
    expect(readOnly("commit")).toBe(false);
  });

  test("pragma is not a read", () => {
    expect(readOnly("pragma journal_mode = wal", "sqlite")).toBe(false);
  });

  test("function call that can mutate", () => {
    expect(readOnly("select nextval('users_id_seq')")).toBe(false);
  });

  test("empty input", () => {
    const r = isReadOnlySql("   \n  ", "postgres");
    expect(r.readOnly).toBe(false);
    expect(r.statements).toBe(0);
  });

  test("garbage does not parse and is therefore not read-only", () => {
    expect(readOnly("select from where )(")).toBe(false);
  });
});

describe("classifyStatements", () => {
  test("labels each statement", () => {
    const out = classifyStatements("select 1; insert into t values (1); create table x (a int)", "postgres");
    expect(out.map((s) => s.kind)).toEqual(["read", "write", "ddl"]);
  });

  test("mysql backtick identifiers", () => {
    const out = classifyStatements("select `select` from `orders`", "mysql");
    expect(out[0]!.kind).toBe("read");
  });

  test("sqlite select", () => {
    expect(classifyStatements("select * from sqlite_master", "sqlite")[0]!.kind).toBe("read");
  });
});

describe("explainGuard", () => {
  test("allows a single select", () => {
    expect(explainGuard("select * from t where id = 1", "postgres")).toBeUndefined();
  });

  test("allows planning a single DML statement (EXPLAIN without ANALYZE does not execute)", () => {
    expect(explainGuard("update t set a = 1", "postgres")).toBeUndefined();
  });

  test("rejects a statement batch", () => {
    expect(explainGuard("select 1; delete from t", "postgres")).toMatch(/one statement/);
    expect(explainGuard("select 1 /* ; */; drop table t", "mysql")).toMatch(/one statement/);
  });

  test("rejects a leading ANALYZE / EXPLAIN", () => {
    expect(explainGuard("analyze delete from t", "mysql")).toMatch(/ANALYZE/);
    expect(explainGuard("/* c */ ANALYSE select 1", "postgres")).toMatch(/ANALYZE/);
    expect(explainGuard("explain analyze select 1", "postgres")).toMatch(/nested/);
  });

  test("rejects empty input", () => {
    expect(explainGuard("  -- nothing\n", "sqlite")).toBeDefined();
  });
});

describe("side-effect function deny-list", () => {
  test("postgres: session/lock/file/sleep functions are not read-only", () => {
    for (const sql of [
      "select pg_terminate_backend(123)",
      "select pg_cancel_backend(pid) from pg_stat_activity",
      "select pg_advisory_lock(1)",
      "select pg_try_advisory_xact_lock(1)",
      "select * from dblink_exec('host=x', 'delete from t')",
      "select pg_read_file('/etc/passwd')",
      "select pg_read_binary_file('/etc/passwd')",
      "select * from pg_ls_dir('.')",
      "select lo_import('/etc/passwd')",
      "select PG_SLEEP(100)",
      "select pg_sleep_for('1 hour')",
      "select set_config('statement_timeout', '0', true)",
    ]) {
      expect(isReadOnlySql(sql, "postgres").readOnly, sql).toBe(false);
      expect(isReadOnlySql(sql, "postgres").reason, sql).toMatch(/side effects/);
    }
  });

  test("mysql: sleep / benchmark / load_file / sys_exec / locks", () => {
    for (const sql of [
      "select sleep(10)",
      "select benchmark(1000000, md5('x'))",
      "select load_file('/etc/passwd')",
      "select sys_exec('id')",
      "select get_lock('x', 10)",
    ]) {
      expect(isReadOnlySql(sql, "mysql").readOnly, sql).toBe(false);
    }
  });

  test("sqlite: load_extension / writefile / readfile", () => {
    for (const sql of ["select load_extension('x')", "select writefile('a', 'b')", "select readfile('/etc/passwd')"]) {
      expect(isReadOnlySql(sql, "sqlite").readOnly, sql).toBe(false);
    }
  });

  test("names inside strings/identifiers and ordinary functions still pass", () => {
    expect(isReadOnlySql("select 'pg_sleep(1)' as note, \"lo_import\" from t", "postgres").readOnly).toBe(true);
    expect(isReadOnlySql("select pg_backend_pid(), now(), count(*) from t", "postgres").readOnly).toBe(true);
    expect(isReadOnlySql("select sleeping from beds", "mysql").readOnly).toBe(true);
  });
});
