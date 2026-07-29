export interface EmailSummary {
  id: string;
  alias: string;
  domain: string;
  toAddr: string;
  envelopeFrom: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  dateHeader: number | null;
  receivedAt: number;
  sizeBytes: number;
  hasHtml: boolean;
  attachmentCount: number;
  parseError: boolean;
  forwardTo: string | null;
  forwardError: string | null;
}

export interface EmailWithBody extends EmailSummary {
  textBody: string | null;
}

export interface ListEmailsResponse {
  emails: EmailSummary[] | EmailWithBody[];
  cursor: string | null;
}

export interface AliasRecord {
  alias: string;
  domain: string;
  status: "active" | "blocked";
  note: string | null;
  forwardTo: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  emailCount: number;
}

export interface ListAliasesResponse {
  aliases: AliasRecord[];
}

export interface DeleteResponse {
  deleted: number;
}

export type EmailAddressInput = string | { email: string; name?: string };

export interface OutboundAttachmentInput {
  content: string;
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

export interface SendEmailRequest {
  version: 1;
  id: string;
  from: EmailAddressInput;
  to: EmailAddressInput | EmailAddressInput[];
  subject: string;
  text?: string;
  html?: string;
  cc?: EmailAddressInput | EmailAddressInput[];
  bcc?: EmailAddressInput | EmailAddressInput[];
  replyTo?: EmailAddressInput;
  attachments?: OutboundAttachmentInput[];
  headers?: Record<string, string>;
}

export interface ReplyEmailRequest {
  version: 1;
  id: string;
  text?: string;
  html?: string;
  cc?: EmailAddressInput | EmailAddressInput[];
  bcc?: EmailAddressInput | EmailAddressInput[];
  attachments?: OutboundAttachmentInput[];
  headers?: Record<string, string>;
  replyAll?: boolean;
  quote?: boolean;
}

export interface SentRecipient {
  email: string;
  kind: "to" | "cc" | "bcc";
  status: string;
  updatedAt: number;
  detail: string | null;
}

export interface SentEmailSummary {
  id: string;
  alias: string;
  domain: string;
  fromAddr: string;
  subject: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  messageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recipientCount: number;
}

export interface SentEmail extends SentEmailSummary {
  recipients: SentRecipient[];
}

export interface ListSentEmailsResponse {
  emails: SentEmailSummary[];
  cursor: string | null;
}

export type ApiErrorCode = "unauthorized" | "bad_request" | "not_found" | "internal";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export const ROUTES = {
  emails: "/v1/emails",
  email: (id: string) => `/v1/emails/${id}`,
  emailRaw: (id: string) => `/v1/emails/${id}/raw`,
  reply: (id: string) => `/v1/emails/${id}/reply`,
  sent: "/v1/sent",
  sentEmail: (id: string) => `/v1/sent/${id}`,
  sentPayload: (id: string) => `/v1/sent/${id}/payload`,
  aliases: "/v1/aliases",
  alias: (domain: string, alias: string) => `/v1/aliases/${domain}/${alias}`
} as const;
