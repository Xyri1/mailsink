import type { OutboundAttachmentInput } from "@mailsink/shared";

export interface Env {
  API_TOKEN: string;
  BLOCK_MODE?: "reject" | "drop" | string;
  DB: Database;
  RAW: RawBucket;
  EMAIL: SendEmailBinding;
}

type ProviderEmailAddress = string | { email: string; name: string };

export interface SendEmailBinding {
  send(message: {
    from: ProviderEmailAddress;
    to: ProviderEmailAddress | ProviderEmailAddress[];
    subject: string;
    text?: string;
    html?: string;
    cc?: ProviderEmailAddress | ProviderEmailAddress[];
    bcc?: ProviderEmailAddress | ProviderEmailAddress[];
    replyTo?: ProviderEmailAddress;
    attachments?: OutboundAttachmentInput[];
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface QueueBatch<T> {
  messages: readonly { body: T }[];
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
  forward_to: string | null;
  forward_error: string | null;
  html_body?: string | null;
  message_id?: string | null;
  reply_to?: string | null;
  references_header?: string | null;
  to_header?: string | null;
  cc_header?: string | null;
}

export interface AliasRow {
  alias: string;
  domain: string;
  status: "active" | "blocked";
  note: string | null;
  forward_to: string | null;
  first_seen_at: number;
  last_seen_at: number;
  email_count: number;
}

export interface SentEmailRow {
  id: string;
  alias: string;
  domain: string;
  from_addr: string;
  subject: string;
  created_at: number;
  updated_at: number;
  status: string;
  message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  recipient_count: number;
  r2_key: string;
}

export interface SentRecipientRow {
  sent_id: string;
  email: string;
  kind: "to" | "cc" | "bcc";
  status: string;
  updated_at: number;
  detail: string | null;
}
