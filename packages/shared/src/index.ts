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
  aliases: "/v1/aliases",
  alias: (domain: string, alias: string) => `/v1/aliases/${domain}/${alias}`
} as const;
