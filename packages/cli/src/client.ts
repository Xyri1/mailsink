import type {
  AliasRecord,
  ApiError,
  DeleteResponse,
  EmailWithBody,
  ListAliasesResponse,
  ListEmailsResponse
} from "@mailsink/shared";
import { ROUTES } from "@mailsink/shared";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MailsinkApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "MailsinkApiError";
  }
}

export class MailsinkNetworkError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`network failure while calling ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MailsinkNetworkError";
  }
}

export class MailsinkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetch: Fetch = globalThis.fetch
  ) {}

  listAliases(params: { q?: string; domain?: string; status?: "active" | "blocked"; routed?: boolean; limit?: number } = {}) {
    return this.request<ListAliasesResponse>("GET", ROUTES.aliases, params);
  }

  patchAlias(domain: string, alias: string, body: {
    status?: "active" | "blocked";
    note?: string | null;
    forwardTo?: string | null;
  }) {
    return this.request<AliasRecord>("PATCH", ROUTES.alias(encodeURIComponent(domain), encodeURIComponent(alias)), {}, body);
  }

  listEmails(params: { alias?: string; domain?: string; from?: string; limit?: number; includeBody?: boolean } = {}) {
    const { includeBody, ...query } = params;
    return this.request<ListEmailsResponse>("GET", ROUTES.emails, {
      ...query,
      include: includeBody ? "body" : undefined
    });
  }

  getEmail(id: string) {
    return this.request<EmailWithBody>("GET", ROUTES.email(encodeURIComponent(id)));
  }

  async getRawEmail(id: string) {
    const response = await this.fetchRequest("GET", ROUTES.emailRaw(encodeURIComponent(id)));
    if (!response.ok) await this.throwApiError(response);
    return response.text();
  }

  deleteEmail(id: string) {
    return this.request<DeleteResponse>("DELETE", ROUTES.email(encodeURIComponent(id)));
  }

  deleteEmailsByAlias(alias: string, domain: string) {
    return this.request<DeleteResponse>("DELETE", ROUTES.emails, { alias, domain });
  }

  private async request<T>(method: string, path: string, query: Record<string, unknown> = {}, body?: unknown): Promise<T> {
    const response = await this.fetchRequest(method, path, query, body);
    if (!response.ok) await this.throwApiError(response);
    return response.json() as Promise<T>;
  }

  private async fetchRequest(method: string, path: string, query: Record<string, unknown> = {}, body?: unknown) {
    const url = new URL(path, normalizedBaseUrl(this.baseUrl));
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        }
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      return await this.fetch(url.toString(), init);
    } catch (error) {
      throw new MailsinkNetworkError(url.toString(), error);
    }
  }

  private async throwApiError(response: Response): Promise<never> {
    let message = response.statusText;
    let code = "unknown";
    try {
      const body = await response.json() as ApiError;
      message = body.error.message;
      code = body.error.code;
    } catch {
      message = await response.text();
    }
    throw new MailsinkApiError(response.status, code, message);
  }
}

function normalizedBaseUrl(value: string) {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  return absolute.endsWith("/") ? absolute : `${absolute}/`;
}
