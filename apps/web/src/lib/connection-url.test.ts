import { describe, expect, test } from "bun:test";

import { connectionUrlFromFields, fieldsFromConnectionUrl } from "./connection-url";

describe("connection URL field conversion", () => {
  test("deconstructs a Postgres URL into editable fields", () => {
    expect(fieldsFromConnectionUrl("postgres://app%40team:s%23cret@db.example.com:5544/acme%20prod?sslmode=require", "postgres"))
      .toEqual({
        host: "db.example.com",
        port: "5544",
        database: "acme prod",
        user: "app@team",
        password: "s#cret",
      });
  });

  test("uses the dialect default port when the URL omits it", () => {
    expect(fieldsFromConnectionUrl("mysql://root:secret@localhost/shop", "mysql")?.port).toBe("3306");
    expect(fieldsFromConnectionUrl("postgresql://root:secret@localhost/shop", "postgres")?.port).toBe("5432");
  });

  test("rebuilds the URL and preserves its extra options", () => {
    const result = connectionUrlFromFields(
      { host: "db.internal", port: "6432", database: "main", user: "reader", password: "new secret" },
      "postgres",
      "postgres://old:old@old-host/old-db?sslmode=require&application_name=dbchat",
    );
    const url = new URL(result);
    expect(url.protocol).toBe("postgres:");
    expect(url.hostname).toBe("db.internal");
    expect(url.port).toBe("6432");
    expect(url.pathname).toBe("/main");
    expect(decodeURIComponent(url.username)).toBe("reader");
    expect(decodeURIComponent(url.password)).toBe("new secret");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("application_name")).toBe("dbchat");
  });

  test("rejects malformed and wrong-dialect URLs", () => {
    expect(fieldsFromConnectionUrl("not a URL", "postgres")).toBeUndefined();
    expect(fieldsFromConnectionUrl("mysql://root@localhost/shop", "postgres")).toBeUndefined();
  });
});
