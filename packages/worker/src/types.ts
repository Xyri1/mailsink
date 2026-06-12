export interface Env {
  API_TOKEN: string;
  BLOCK_MODE?: "reject" | "drop" | string;
  DB: Database;
  RAW: RawBucket;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  batch<T = unknown>(statements: PreparedStatement[]): Promise<T[]>;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface RawBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null } | null>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ objects: { key: string }[]; truncated: boolean }>;
}

export interface EmailRow {
  id: string;
  alias: string;
  domain: string;
  to_addr: string;
  envelope_from: string;
  from_addr: string;
  from_name: string | null;
  subject: string | null;
  date_header: number | null;
  received_at: number;
  size_bytes: number;
  text_body: string | null;
  has_html: number;
  attachment_count: number;
  parse_error: number;
  r2_key: string;
}

export interface AliasRow {
  alias: string;
  domain: string;
  status: "active" | "blocked";
  note: string | null;
  first_seen_at: number;
  last_seen_at: number;
  email_count: number;
}
