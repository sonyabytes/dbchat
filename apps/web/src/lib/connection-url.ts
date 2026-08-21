import type { Dialect } from "@dbchat/contracts";

export interface ConnectionUrlFields {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

const schemeFor = (dialect: Dialect) => dialect === "mysql" ? "mysql:" : "postgres:";
const defaultPortFor = (dialect: Dialect) => dialect === "mysql" ? "3306" : "5432";

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Parse the editable parts of a Postgres/MySQL URL into the fields tab. */
export function fieldsFromConnectionUrl(raw: string, dialect: Dialect): ConnectionUrlFields | undefined {
  if (dialect === "sqlite") return undefined;
  try {
    const url = new URL(raw);
    const acceptedProtocols = dialect === "mysql" ? ["mysql:"] : ["postgres:", "postgresql:"];
    if (!acceptedProtocols.includes(url.protocol)) return undefined;
    return {
      host: url.hostname,
      port: url.port || defaultPortFor(dialect),
      database: decode(url.pathname.replace(/^\//, "")),
      user: decode(url.username),
      password: decode(url.password),
    };
  } catch {
    return undefined;
  }
}

/** Build a URL from the fields tab, retaining options from the previous URL when possible. */
export function connectionUrlFromFields(
  fields: ConnectionUrlFields,
  dialect: Dialect,
  previousUrl = "",
): string {
  if (dialect === "sqlite") return "";
  const scheme = schemeFor(dialect);
  let url: URL;
  try {
    url = new URL(previousUrl);
  } catch {
    url = new URL(`${scheme}//localhost`);
  }
  url.protocol = scheme;
  url.hostname = fields.host;
  url.port = fields.port;
  url.username = fields.user;
  url.password = fields.password;
  url.pathname = `/${fields.database}`;
  return url.toString();
}
