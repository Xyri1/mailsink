import type { Env } from "../src/types";

type Row = Record<string, unknown>;

type EmailRow = Row & { id: string; alias: string; domain: string; r2_key: string };
type AliasRow = Row & { alias: string; domain: string; status: string; email_count: number };
type SentEmailRow = Row & {
  id: string;
  alias: string;
  domain: string;
  message_id: string | null;
  r2_key: string;
};
type SentRecipientRow = Row & {
  sent_id: string;
  email: string;
  kind: string;
  status: string;
  updated_at: number;
};

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
  sentEmails = new Map<string, SentEmailRow>();
  sentRecipients = new Map<string, SentRecipientRow>();
  failOnSql: string | null = null;
  beforeBatch: (() => void) | null = null;

  prepare(sql: string) {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]): Promise<T[]> {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    beforeBatch?.();
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results as T[];
  }

  aliasKey(alias: string, domain: string) {
    return `${domain}\0${alias}`;
  }

  recipientKey(sentId: string, email: string) {
    return `${sentId}\0${email.toLowerCase()}`;
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
    if (sql.includes("FROM sent_emails WHERE id = ?")) {
      return (this.db.sentEmails.get(String(this.bindings[0])) ?? null) as T | null;
    }
    if (sql.includes("FROM sent_emails WHERE message_id = ?")) {
      return ([...this.db.sentEmails.values()].find((row) => row.message_id === this.bindings[0]) ?? null) as T | null;
    }
    if (sql.includes("FROM sent_recipients") && sql.includes("lower(email)")) {
      return (this.db.sentRecipients.get(
        this.db.recipientKey(String(this.bindings[0]), String(this.bindings[1]))
      ) ?? null) as T | null;
    }
    if (sql.includes("FROM aliases WHERE alias = ? AND domain = ?")) {
      return (this.db.aliases.get(this.db.aliasKey(String(this.bindings[0]), String(this.bindings[1]))) ?? null) as T | null;
    }
    if (sql.includes("FROM emails WHERE id = ?")) {
      return (this.db.emails.get(String(this.bindings[0])) ?? null) as T | null;
    }
    return ((await this.all<T>()).results[0] ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM sent_emails")) {
      return { results: this.listSentEmails() as T[] };
    }
    if (this.sql.includes("FROM sent_recipients")) {
      return {
        results: [...this.db.sentRecipients.values()]
          .filter((row) => row.sent_id === this.bindings[0]) as T[]
      };
    }
    if (this.sql.includes("FROM emails")) {
      return { results: this.listEmails() as T[] };
    }
    if (this.sql.includes("FROM aliases")) {
      return { results: this.listAliases() as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.db.failOnSql && this.sql.includes(this.db.failOnSql)) {
      throw new Error(`injected D1 failure: ${this.db.failOnSql}`);
    }
    const sql = this.sql.trimStart();

    if (sql.startsWith("INSERT INTO sent_emails")) {
      const [
        id, alias, domain, from_addr, subject, created_at, updated_at,
        recipient_count, r2_key
      ] = this.bindings;
      if (this.db.sentEmails.has(String(id))) throw new Error("UNIQUE constraint failed: sent_emails.id");
      this.db.sentEmails.set(String(id), {
        id: String(id),
        alias: String(alias),
        domain: String(domain),
        from_addr,
        subject,
        created_at,
        updated_at,
        status: "submitting",
        message_id: null,
        error_code: null,
        error_message: null,
        recipient_count,
        r2_key: String(r2_key)
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO sent_recipients")) {
      const [sent_id, email, kind] = this.bindings;
      this.db.sentRecipients.set(this.db.recipientKey(String(sent_id), String(email)), {
        sent_id: String(sent_id),
        email,
        kind,
        status: "submitting",
        updated_at: 0,
        detail: null
      } as SentRecipientRow);
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO emails")) {
      const [
        id, alias, domain, to_addr, envelope_from, from_addr, from_name, subject,
        date_header, received_at, size_bytes, text_body, has_html, attachment_count,
        parse_error, r2_key, forward_to, html_body, message_id, reply_to,
        references_header, to_header, cc_header
      ] = this.bindings;
      this.db.emails.set(String(id), {
        id: String(id), alias: String(alias), domain: String(domain), to_addr,
        envelope_from, from_addr, from_name, subject, date_header, received_at,
        size_bytes, text_body, has_html, attachment_count, parse_error, r2_key, forward_to,
        forward_error: null, html_body, message_id, reply_to, references_header, to_header, cc_header
      } as EmailRow);
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("INSERT INTO aliases")) {
      if (this.sql.includes("VALUES (?, ?, 'active', NULL, NULL")) {
        const [alias, domain, first_seen_at, last_seen_at] = this.bindings;
        const key = this.db.aliasKey(String(alias), String(domain));
        const current = this.db.aliases.get(key);
        this.db.aliases.set(key, current ? {
          ...current,
          last_seen_at
        } : {
          alias: String(alias),
          domain: String(domain),
          status: "active",
          note: null,
          forward_to: null,
          first_seen_at,
          last_seen_at,
          email_count: 0
        } as AliasRow);
        return { success: true, meta: { changes: 1 } };
      }
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

    if (sql.startsWith("UPDATE sent_emails")) {
      if (sql.includes("message_id = ?")) {
        const row = this.db.sentEmails.get(String(this.bindings[2]));
        if (row) Object.assign(row, {
          status: "accepted",
          message_id: this.bindings[0],
          updated_at: this.bindings[1]
        });
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      if (sql.includes("error_code = ?")) {
        const row = this.db.sentEmails.get(String(this.bindings[3]));
        if (row) Object.assign(row, {
          status: "failed",
          error_code: this.bindings[0],
          error_message: this.bindings[1],
          updated_at: this.bindings[2]
        });
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      const row = this.db.sentEmails.get(String(this.bindings[2]));
      if (row) Object.assign(row, { status: this.bindings[0], updated_at: this.bindings[1] });
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }

    if (sql.startsWith("UPDATE sent_recipients")) {
      if (sql.includes("lower(email) = lower(?)")) {
        const row = this.db.sentRecipients.get(
          this.db.recipientKey(String(this.bindings[3]), String(this.bindings[4]))
        );
        if (row) Object.assign(row, {
          status: this.bindings[0],
          updated_at: this.bindings[1],
          detail: this.bindings[2]
        });
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      const accepted = sql.includes("status = 'accepted'");
      const sentId = String(accepted ? this.bindings[1] : this.bindings[2]);
      let changes = 0;
      for (const row of this.db.sentRecipients.values()) {
        if (row.sent_id !== sentId) continue;
        if (accepted) Object.assign(row, {
          status: "accepted",
          updated_at: this.bindings[0],
          detail: null
        });
        else Object.assign(row, {
          status: "failed",
          updated_at: this.bindings[0],
          detail: this.bindings[1]
        });
        changes++;
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("DELETE FROM sent_recipients")) {
      let changes = 0;
      if (sql.includes("SELECT id FROM sent_emails")) {
        const [alias, domain] = this.bindings;
        const ids = new Set([...this.db.sentEmails.values()]
          .filter((row) => row.alias === alias && row.domain === domain)
          .map((row) => row.id));
        for (const [key, row] of this.db.sentRecipients) {
          if (ids.has(row.sent_id)) {
            this.db.sentRecipients.delete(key);
            changes++;
          }
        }
      } else {
        for (const [key, row] of this.db.sentRecipients) {
          if (row.sent_id === this.bindings[0]) {
            this.db.sentRecipients.delete(key);
            changes++;
          }
        }
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("DELETE FROM sent_emails WHERE id = ?")) {
      const deleted = this.db.sentEmails.delete(String(this.bindings[0])) ? 1 : 0;
      return { success: true, meta: { changes: deleted } };
    }

    if (sql.startsWith("DELETE FROM sent_emails WHERE alias = ? AND domain = ?")) {
      let deleted = 0;
      for (const [id, row] of this.db.sentEmails) {
        if (row.alias === this.bindings[0] && row.domain === this.bindings[1]) {
          this.db.sentEmails.delete(id);
          deleted++;
        }
      }
      return { success: true, meta: { changes: deleted } };
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

  private listSentEmails() {
    let rows = [...this.db.sentEmails.values()];
    const [alias, , domain, , status, , to, , cursor, , limit] = this.bindings;
    if (alias) rows = rows.filter((row) => row.alias === alias);
    if (domain) rows = rows.filter((row) => row.domain === domain);
    if (status) rows = rows.filter((row) => row.status === status);
    if (to) {
      rows = rows.filter((row) => [...this.db.sentRecipients.values()].some((recipient) =>
        recipient.sent_id === row.id &&
        String(recipient.email).toLowerCase() === String(to).toLowerCase()
      ));
    }
    if (cursor) {
      const cursorRow = this.db.sentEmails.get(String(cursor));
      rows = cursorRow ? rows.filter((row) =>
        Number(row.created_at) < Number(cursorRow.created_at) ||
        Number(row.created_at) === Number(cursorRow.created_at) && row.id < cursorRow.id
      ) : [];
    }
    rows.sort((a, b) =>
      Number(b.created_at) - Number(a.created_at) || b.id.localeCompare(a.id)
    );
    return rows.slice(0, Number(limit));
  }
}

export function makeEnv(overrides: Partial<{ BLOCK_MODE: string; API_TOKEN: string }> = {}) {
  return {
    API_TOKEN: "test-token",
    BLOCK_MODE: "reject",
    DB: new FakeD1Database(),
    RAW: new FakeR2Bucket(),
    EMAIL: {
      async send(_message: Parameters<Env["EMAIL"]["send"]>[0]) {
        return { messageId: "fake-message-id" };
      }
    },
    ...overrides
  } satisfies Env & { DB: FakeD1Database; RAW: FakeR2Bucket };
}
