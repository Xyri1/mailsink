import { beforeEach, describe, expect, test } from "vitest";
import type { AliasRecord, EmailSummary, EmailWithBody } from "@mailsink/shared";
import { runCli } from "../src/index";
import type { CliConfig, CredentialStore } from "../src/config";

const config: CliConfig = { url: "https://sink.example.com", defaultDomain: "example.com" };
const token = "test-token";
let aliases: AliasRecord[];
let emails: EmailWithBody[];
let raws: Map<string, string>;
let savedConfig: CliConfig | null;
let savedToken: string | null;
let cloudflareActions: string[];
let initOrder: string[];
let expectedNewHostToken: string;
let promptModes: unknown[];

beforeEach(() => {
  savedConfig = null;
  savedToken = null;
  cloudflareActions = [];
  initOrder = [];
  expectedNewHostToken = "new-token";
  promptModes = [];
  aliases = [
    alias("netflix-x7f2", { note: "trial", emailCount: 2 }),
    alias("networking", { note: null, emailCount: 1 }),
    alias("github-a1", { status: "blocked", note: "leaked", emailCount: 1 })
  ];
  emails = [
    email("01K7VTNH030000000000000000", "networking", { subject: "Coffee?", fromAddr: "me@example.net", receivedAt: 1781251320000 }),
    email("01K7VTNH020000000000000000", "netflix-x7f2", { subject: "HTML code", textBody: null, hasHtml: true, receivedAt: 1781251260000 }),
    email("01K7VTNH010000000000000000", "netflix-x7f2", { subject: "Your sign-in code", textBody: "Your code is 123456.", receivedAt: 1781251200000 })
  ];
  raws = new Map([["01K7VTNH010000000000000000", "raw message"]]);
});

describe("read commands", () => {
  test("latest fans out across fuzzy alias matches", async () => {
    const result = await cli(["latest", "net"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("networking@example.com");
    expect(result.stdout).toContain("Coffee?");
    expect(result.stdout).toContain("netflix-x7f2@example.com");
    expect(result.stdout).toContain("HTML-only message; mailsink raw 01K7VTNH020000000000000000 for the original");
  });

  test("ls merges matching aliases newest first and marks parse errors", async () => {
    emails.unshift(email("01K7VTNH040000000000000000", "netflix-x7f2", {
      subject: "Broken",
      parseError: true,
      receivedAt: 1781251380000
    }));

    const result = await cli(["ls", "net", "--from", "example", "--limit", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.indexOf("Broken")).toBeLessThan(result.stdout.indexOf("Coffee?"));
    expect(result.stdout).toContain("!");
  });

  test("read commands return exit 1 on zero fuzzy matches", async () => {
    const result = await cli(["latest", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no aliases matched missing@example.com");
  });

  test("--json returns the untouched API payload", async () => {
    const result = await cli(["show", "01K7VTNH010000000000000000", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "01K7VTNH010000000000000000",
      textBody: "Your code is 123456."
    });
  });
});

describe("write commands", () => {
  test("write commands reject ambiguous fuzzy aliases", async () => {
    const result = await cli(["burn", "net"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("multiple aliases matched net@example.com");
    expect(result.stderr).toContain("netflix-x7f2@example.com");
    expect(result.stderr).toContain("networking@example.com");
  });

  test("burn pre-blocks explicit aliases that have never received mail", async () => {
    const result = await cli(["burn", "promo-new@example.com"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("blocked promo-new@example.com");
    expect(aliases.find((record) => record.alias === "promo-new")?.status).toBe("blocked");
  });

  test("purge confirms before deleting all mail for one alias", async () => {
    const result = await cli(["purge", "netflix"], { confirm: async () => true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted 2 emails from netflix-x7f2@example.com");
    expect(emails.some((message) => message.alias === "netflix-x7f2")).toBe(false);
  });
});

describe("config and credentials", () => {
  test("login runs the Cloudflare browser login flow without touching mailsink setup", async () => {
    const result = await cli(["login"], {
      prompts: async () => {
        initOrder.push("prompt");
        return { url: "", defaultDomain: "" };
      },
      cloudflareSetup: {
        ensureLogin: async () => {
          cloudflareActions.push("login");
        },
        logout: async () => {
          cloudflareActions.push("logout");
        },
        whoami: async () => {
          cloudflareActions.push("whoami");
          return "user@example.com\n";
        },
        putWorkerSecret: async (token) => {
          cloudflareActions.push(`secret:${token}`);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("logged in to Cloudflare");
    expect(cloudflareActions).toEqual(["login"]);
    expect(initOrder).toEqual([]);
    expect(savedConfig).toBeNull();
    expect(savedToken).toBeNull();
  });

  test("whoami reports the Cloudflare Wrangler session without touching mailsink setup", async () => {
    const result = await cli(["whoami"], {
      prompts: async () => {
        initOrder.push("prompt");
        return { url: "", defaultDomain: "" };
      },
      cloudflareSetup: {
        ensureLogin: async () => {
          cloudflareActions.push("login");
        },
        logout: async () => {
          cloudflareActions.push("logout");
        },
        whoami: async () => {
          cloudflareActions.push("whoami");
          return "user@example.com\n";
        },
        putWorkerSecret: async (token) => {
          cloudflareActions.push(`secret:${token}`);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("user@example.com\n");
    expect(cloudflareActions).toEqual(["whoami"]);
    expect(initOrder).toEqual([]);
    expect(savedConfig).toBeNull();
    expect(savedToken).toBeNull();
  });

  test("logout clears the Cloudflare Wrangler session without touching mailsink setup", async () => {
    const result = await cli(["logout"], {
      prompts: async () => {
        initOrder.push("prompt");
        return { url: "", defaultDomain: "" };
      },
      cloudflareSetup: {
        ensureLogin: async () => {
          cloudflareActions.push("login");
        },
        logout: async () => {
          cloudflareActions.push("logout");
        },
        whoami: async () => {
          cloudflareActions.push("whoami");
          return "user@example.com\n";
        },
        putWorkerSecret: async (token) => {
          cloudflareActions.push(`secret:${token}`);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("logged out of Cloudflare");
    expect(cloudflareActions).toEqual(["logout"]);
    expect(initOrder).toEqual([]);
    expect(savedConfig).toBeNull();
    expect(savedToken).toBeNull();
  });

  test("environment variables override config file and keyring", async () => {
    const result = await cli(["aliases", "--json"], {
      env: { MAILSINK_URL: "https://env.example.com", MAILSINK_TOKEN: "env-token" }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).aliases).toHaveLength(3);
  });

  test("init validates credentials before saving config and token", async () => {
    const result = await cli(["init"], {
      prompts: async () => ({
        url: "https://new.example.com",
        token: "new-token",
        defaultDomain: "example.net"
      })
    });

    expect(result.exitCode).toBe(0);
    expect(savedConfig).toEqual({ url: "https://new.example.com", defaultDomain: "example.net" });
    expect(savedToken).toBe("new-token");
  });

  test("init normalizes bare Worker hostnames to https URLs", async () => {
    const result = await cli(["init"], {
      prompts: async () => ({
        url: "new.example.com",
        token: "new-token",
        defaultDomain: "example.net"
      })
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(savedConfig).toEqual({ url: "https://new.example.com", defaultDomain: "example.net" });
    expect(savedToken).toBe("new-token");
  });

  test("init --cloudflare logs in through Wrangler and stores the generated Worker token", async () => {
    expectedNewHostToken = "generated-worker-token";
    const result = await cli(["init", "--cloudflare"], {
      prompts: async (mode) => {
        initOrder.push("prompt");
        promptModes.push(mode);
        return {
          url: "https://new.example.com",
          token: "ignored-prompt-token",
          defaultDomain: "example.net"
        };
      },
      generateToken: () => "generated-worker-token",
      cloudflareSetup: {
        ensureLogin: async () => {
          cloudflareActions.push("login");
          initOrder.push("login");
        },
        logout: async () => {
          cloudflareActions.push("logout");
        },
        whoami: async () => {
          cloudflareActions.push("whoami");
          return "user@example.com\n";
        },
        putWorkerSecret: async (token) => {
          cloudflareActions.push(`secret:${token}`);
          initOrder.push("secret");
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("initialized mailsink with Cloudflare-assisted setup");
    expect(cloudflareActions).toEqual(["login", "secret:generated-worker-token"]);
    expect(initOrder).toEqual(["login", "prompt", "secret"]);
    expect(promptModes).toEqual([{ askToken: false }]);
    expect(savedConfig).toEqual({ url: "https://new.example.com", defaultDomain: "example.net" });
    expect(savedToken).toBe("generated-worker-token");
  });

  test("init --cloudflare rejects blank local setup values before uploading the Worker secret", async () => {
    const result = await cli(["init", "--cloudflare"], {
      prompts: async () => ({
        url: "",
        defaultDomain: ""
      }),
      generateToken: () => "generated-worker-token",
      cloudflareSetup: {
        ensureLogin: async () => { cloudflareActions.push("login"); },
        logout: async () => { cloudflareActions.push("logout"); },
        whoami: async () => {
          cloudflareActions.push("whoami");
          return "user@example.com\n";
        },
        putWorkerSecret: async (token) => { cloudflareActions.push(`secret:${token}`); }
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("API URL is required");
    expect(cloudflareActions).toEqual(["login"]);
    expect(savedConfig).toBeNull();
    expect(savedToken).toBeNull();
  });
});

async function cli(args: string[], overrides: Partial<Parameters<typeof runCli>[1]> = {}) {
  return runCli(args, {
    configStore: {
      read: async () => config,
      write: async (value) => { savedConfig = value; }
    },
    credentialStore,
    fetch: fakeFetch,
    now: () => 1781251500000,
    ...overrides
  });
}

const credentialStore: CredentialStore = {
  readToken: async () => token,
  writeToken: async (value) => { savedToken = value; }
};

async function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const expectedToken = url.hostname === "env.example.com" ? "env-token" : url.hostname === "new.example.com" ? expectedNewHostToken : token;
  expect(request.headers.get("Authorization")).toBe(`Bearer ${expectedToken}`);

  if (url.pathname === "/v1/aliases" && request.method === "GET") {
    const query = url.searchParams.get("q");
    const status = url.searchParams.get("status");
    const domain = url.searchParams.get("domain");
    return json({
      aliases: aliases.filter((record) =>
        (!query || record.alias.includes(query)) &&
        (!status || record.status === status) &&
        (!domain || record.domain === domain)
      )
    });
  }

  if (url.pathname.startsWith("/v1/aliases/") && request.method === "PATCH") {
    const [, , , domain, aliasName] = url.pathname.split("/") as [string, string, string, string, string];
    const body = await request.json() as { status?: "active" | "blocked"; note?: string | null };
    const existing = aliases.find((record) => record.alias === aliasName && record.domain === domain);
    if (existing) {
      existing.status = body.status ?? "active";
      existing.note = body.note ?? null;
      return json(existing);
    }
    const record = alias(aliasName!, {
      domain,
      status: body.status ?? "active",
      note: body.note ?? null,
      emailCount: 0
    });
    aliases.push(record);
    return json(record);
  }

  if (url.pathname === "/v1/emails" && request.method === "GET") {
    const aliasName = url.searchParams.get("alias");
    const domain = url.searchParams.get("domain");
    const from = url.searchParams.get("from");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    return json({
      emails: emails
        .filter((message) =>
          (!aliasName || message.alias === aliasName) &&
          (!domain || message.domain === domain) &&
          (!from || message.fromAddr.includes(from) || message.fromName?.includes(from))
        )
        .slice(0, limit),
      cursor: null
    });
  }

  if (url.pathname === "/v1/emails" && request.method === "DELETE") {
    const aliasName = url.searchParams.get("alias");
    const domain = url.searchParams.get("domain");
    const before = emails.length;
    emails = emails.filter((message) => message.alias !== aliasName || message.domain !== domain);
    return json({ deleted: before - emails.length });
  }

  const emailMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)$/);
  if (emailMatch && request.method === "GET") {
    const message = emails.find((candidate) => candidate.id === emailMatch[1]);
    return message ? json(message) : json({ error: { code: "not_found", message: "email not found" } }, 404);
  }
  if (emailMatch && request.method === "DELETE") {
    const before = emails.length;
    emails = emails.filter((message) => message.id !== emailMatch[1]);
    return json({ deleted: before - emails.length });
  }

  const rawMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)\/raw$/);
  if (rawMatch && request.method === "GET") {
    return new Response(raws.get(rawMatch[1]!) ?? "", { status: 200 });
  }

  return json({ error: { code: "not_found", message: "route not found" } }, 404);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function alias(aliasName: string, fields: Partial<AliasRecord> = {}): AliasRecord {
  return {
    alias: aliasName,
    domain: fields.domain ?? "example.com",
    status: fields.status ?? "active",
    note: fields.note ?? null,
    firstSeenAt: fields.firstSeenAt ?? 1781250000000,
    lastSeenAt: fields.lastSeenAt ?? 1781251200000,
    emailCount: fields.emailCount ?? 0
  };
}

function email(id: string, aliasName: string, fields: Partial<EmailWithBody> = {}): EmailWithBody {
  return {
    id,
    alias: aliasName,
    domain: fields.domain ?? "example.com",
    toAddr: fields.toAddr ?? `${aliasName}@example.com`,
    envelopeFrom: fields.envelopeFrom ?? "bounce@example.net",
    fromAddr: fields.fromAddr ?? "sender@example.net",
    fromName: fields.fromName ?? "Sender",
    subject: fields.subject ?? null,
    dateHeader: fields.dateHeader ?? fields.receivedAt ?? 1781251200000,
    receivedAt: fields.receivedAt ?? 1781251200000,
    sizeBytes: fields.sizeBytes ?? 20,
    hasHtml: fields.hasHtml ?? false,
    attachmentCount: fields.attachmentCount ?? 0,
    parseError: fields.parseError ?? false,
    textBody: "textBody" in fields ? fields.textBody! : "body"
  };
}
