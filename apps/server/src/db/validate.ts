/**
 * Validation for `ConnectionInput`, shared by the connection store (create /
 * update) and the driver registry (test). A `url` short-circuits the per-field
 * requirements — the driver hands it straight to the client library.
 */
import { type ConnectionInput, type Dialect, ValidationError } from "@dbchat/contracts";

export const DEFAULT_PORT: Record<Dialect, number> = { postgres: 5432, mysql: 3306, sqlite: 0, bigquery: 0 };

const blank = (s: string | undefined): boolean => s === undefined || s.trim().length === 0;

/** Returns `undefined` when the input is usable, otherwise the first problem. */
export const validateConnectionInput = (input: ConnectionInput): ValidationError | undefined => {
  if (blank(input.name)) return new ValidationError({ field: "name", message: "a connection name is required" });

  if (input.port !== undefined) {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return new ValidationError({ field: "port", message: "port must be an integer between 1 and 65535" });
    }
  }

  if (input.dialect === "sqlite") {
    if (blank(input.database) && blank(input.url)) {
      return new ValidationError({ field: "database", message: "sqlite needs a file path in `database`" });
    }
    return undefined;
  }

  if (input.dialect === "bigquery") {
    if (blank(input.database)) {
      return new ValidationError({ field: "database", message: "bigquery needs a Google Cloud project ID" });
    }
    if (!blank(input.password)) {
      try {
        const credentials = JSON.parse(input.password!);
        if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) throw new Error("not an object");
      } catch {
        return new ValidationError({ field: "password", message: "service account credentials must be valid JSON" });
      }
    }
    return undefined;
  }

  if (!blank(input.url)) {
    const scheme = /^([a-z0-9+]+):\/\//i.exec(input.url!.trim());
    if (!scheme) {
      return new ValidationError({ field: "url", message: "url must look like postgres://… or mysql://…" });
    }
    return undefined;
  }

  if (blank(input.host)) return new ValidationError({ field: "host", message: "host is required" });
  if (blank(input.database)) return new ValidationError({ field: "database", message: "database is required" });
  if (blank(input.user)) return new ValidationError({ field: "user", message: "user is required" });
  return undefined;
};
