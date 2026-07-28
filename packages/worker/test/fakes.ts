import type { Env } from "../src/types";

type Row = Record<string, unknown>;

type EmailRow = Row & { id: string; alias: string; domain: string; r2_key: string };
type AliasRow = Row & { alias: string; domain: string; status: string; email_count: number };

export class FakeR2Bucket {
  objects = new Map<string, ArrayBuffer>();

  async put(key: string, value: ArrayBuffer) {
    this.objects.set(key, value);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      body: new Response(value).body,
      httpMetadata: { contentType: "message/rfc822" }
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((key) => !options?.prefix || key.startsWith(options.prefix));
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false
    };
  }
}

export class FakeD1Database {
  emails = new Map<string, EmailRow>();
  aliases = new Map<string, AliasRow>();

  prepare(sql: string) {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]): Promise<T[]> {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results as T[];
  }

  aliasKey(alias: string, domain: string) {
    return `${domain}\0${alias}`;
  }
}

class FakeD1PreparedStatement {
  private bindings: unknown[] = [];

  constructor(private db: FakeD1Database, private sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("FROM aliases WHERE alias = ? AND domain = ?")) {
      return (this.db.aliases.get(this.db.aliasKey(String(this.bindings[0]), String(this.bindings[1]))) ?? null) as T | null;
    }
    if (sql.includes("FROM emails WHERE id = ?")) {
      return (this.db.emails.get(String(this.bindings[0])) ?? null) as T | null;
    }
    return ((await this.all<T>()).results[0] ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM emails")) {
      return { results: this.listEmails() as T[] };
    }
    if (this.sql.includes("FROM aliases")) {
      return { results: this.listAliases() as T[] };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql.trimStart();

    if (sql.startsWith("INSERT INTO emails")) {
      const [
        id, alias, domain, to_addr, envelope_from, from_addr, from_name, subject,
        date_header, received_at, size_bytes, text_body, has_html, attachment_count,
        parse_error, r2_key, forward_to
      ] = this.bindings;
      this.db.emails.set(String(id), {
        id: String(id), alias: String(alias), domain: String(domain), to_addr,
        envelope_from, from_addr, from_name, subject, date_header, received_at,
        size_bytes, text_body, has_html, attachment_count, parse_error, r2_key, forward_to,
        forward_error: null
      } as EmailRow);
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO aliases")) {
      const isPatch = this.sql.includes("excluded.status");
      const [alias, domain] = this.bindings;
      const status = isPatch ? this.bindings[2] : "active";
      const note = isPatch ? this.bindings[3] : null;
      const forward_to = isPatch ? this.bindings[4] : null;
      const first_seen_at = isPatch ? this.bindings[5] : this.bindings[2];
      const last_seen_at = isPatch ? this.bindings[6] : this.bindings[3];
      const key = this.db.aliasKey(String(alias), String(domain));
      const current = this.db.aliases.get(key);
      this.db.aliases.set(key, current ? isPatch ? {
        ...current,
        status: String(status),
        note,
        forward_to,
        last_seen_at
      } as AliasRow : {
        ...current,
        last_seen_at,
        email_count: Number(current.email_count) + 1
      } as AliasRow : {
        alias: String(alias),
        domain: String(domain),
        status: String(status),
        note,
        forward_to,
        first_seen_at,
        last_seen_at,
        email_count: isPatch ? 0 : 1
      } as AliasRow);
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE aliases")) {
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE emails SET forward_error")) {
      const row = this.db.emails.get(String(this.bindings[1]));
      if (row) row.forward_error = this.bindings[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }

    if (sql.startsWith("DELETE FROM emails WHERE id = ?")) {
      const deleted = this.db.emails.delete(String(this.bindings[0])) ? 1 : 0;
      return { success: true, meta: { changes: deleted } };
    }

    if (sql.startsWith("DELETE FROM emails WHERE alias = ? AND domain = ?")) {
      let deleted = 0;
      for (const [id, row] of this.db.emails) {
        if (row.alias === this.bindings[0] && row.domain === this.bindings[1]) {
          this.db.emails.delete(id);
          deleted++;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    return { success: true, meta: { changes: 0 } };
  }

  private listEmails() {
    let rows = [...this.db.emails.values()];
    const [alias, , domain, , from, , , sinceFloor, , cursor, , limit] = this.bindings;
    if (alias) rows = rows.filter((row) => row.alias === alias);
    if (domain) rows = rows.filter((row) => row.domain === domain);
    if (from) {
      const needle = String(from).toLowerCase();
      rows = rows.filter((row) =>
        String(row.from_addr).toLowerCase().includes(needle) ||
        String(row.from_name ?? "").toLowerCase().includes(needle)
      );
    }
    if (sinceFloor) rows = rows.filter((row) => row.id >= String(sinceFloor));
    if (cursor) rows = rows.filter((row) => row.id < String(cursor));
    rows.sort((a, b) => b.id.localeCompare(a.id));
    return rows.slice(0, Number(limit));
  }

  private listAliases() {
    let rows = [...this.db.aliases.values()];
    const [q, , status, , domain, , routed, limit] = this.bindings;
    if (q) rows = rows.filter((row) => row.alias.toLowerCase().includes(String(q).toLowerCase()));
    if (status) rows = rows.filter((row) => row.status === status);
    if (domain) rows = rows.filter((row) => row.domain === domain);
    if (routed) rows = rows.filter((row) => row.forward_to != null);
    rows.sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at));
    return rows.slice(0, Number(limit));
  }
}

export function makeEnv(overrides: Partial<{ BLOCK_MODE: string; API_TOKEN: string }> = {}) {
  return {
    API_TOKEN: "test-token",
    BLOCK_MODE: "reject",
    DB: new FakeD1Database(),
    RAW: new FakeR2Bucket(),
    ...overrides
  } satisfies Env & { DB: FakeD1Database; RAW: FakeR2Bucket };
}
