import { beforeEach, describe, expect, test } from "vitest";
import type { AliasRecord, EmailSummary, EmailWithBody } from "@mailsink/shared";
import { runCli } from "../src/index";
import type { CliConfig, CredentialStore } from "../src/config";
import { parseAliasQuery } from "../src/resolve";

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
let destinationStatus: "verified" | "pending";
let sentEmails: Array<Record<string, unknown>>;
let sentPayloads: Map<string, unknown>;
let requestCount: Map<string, number>;

beforeEach(() => {
  savedConfig = null;
  savedToken = null;
  cloudflareActions = [];
  initOrder = [];
  expectedNewHostToken = "new-token";
  promptModes = [];
  destinationStatus = "verified";
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
  sentEmails = [{
    id: "sent-1",
    alias: "networking",
    domain: "example.com",
    fromAddr: "networking@example.com",
    recipients: [{ email: "friend@example.net", kind: "to", status: "sent", updatedAt: 1781251320000, detail: null }],
    status: "sent",
    subject: "Sent subject",
    createdAt: 1781251320000,
    updatedAt: 1781251320000,
    messageId: null,
    errorCode: null,
    errorMessage: null,
    recipientCount: 1
  }];
  sentPayloads = new Map([["sent-1", { version: 1, id: "sent-1", from: "networking@example.com", to: "friend@example.net", subject: "Sent subject", text: "Sent body" }]]);
  requestCount = new Map();
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

  test("ls inbox merges matching aliases newest first and marks parse errors", async () => {
    emails.unshift(email("01K7VTNH040000000000000000", "netflix-x7f2", {
      subject: "Broken",
      parseError: true,
      receivedAt: 1781251380000
    }));

    const result = await cli(["ls", "inbox", "net", "--from", "example", "--limit", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.indexOf("Broken")).toBeLessThan(result.stdout.indexOf("Coffee?"));
    expect(result.stdout).toContain("!");
  });

  test("ls only accepts inbox or sent directions", async () => {
    const bare = await cli(["ls"]);
    const legacy = await cli(["ls", "net"]);

    expect(bare.exitCode).toBe(1);
    expect(legacy.exitCode).toBe(1);
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

describe("alias parsing", () => {
  test("normalizes inline alias and domain casing", () => {
    expect(parseAliasQuery("NeTWork@Mail.Example", "ignored.example")).toMatchObject({
      alias: "network",
      domain: "mail.example",
      label: "network@mail.example"
    });
  });

  test("normalizes default and overridden domain casing", () => {
    expect(parseAliasQuery("NeTWork", "Default.Example").label).toBe("network@default.example");
    expect(parseAliasQuery("NeTWork", "ignored.example", "Override.Example").label).toBe("network@override.example");
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

  test("purge inbox confirms before deleting all mail for one alias", async () => {
    const result = await cli(["purge", "inbox", "netflix"], { confirm: async () => true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted 2 emails from netflix-x7f2@example.com");
    expect(emails.some((message) => message.alias === "netflix-x7f2")).toBe(false);
  });

  test("purge sent deletes only mail sent by the alias", async () => {
    const result = await cli(["purge", "sent", "networking", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted 1 sent email from networking@example.com");
    expect(sentEmails).toEqual([]);
  });

  test("route reports configured mappings before an alias receives mail", async () => {
    aliases.push(alias("support", { forwardTo: "may@email.com", emailCount: 0 }));

    const result = await cli(["route"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("support@example.com");
    expect(result.stdout).toContain("may@email.com");
  });

  test("route says when no mappings are configured", async () => {
    const result = await cli(["route"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no routes configured");
  });

  test("route preconfigures an explicit unseen alias after destination verification", async () => {
    const result = await cli(["route", "support@example.com", "may@email.com"], {
      cloudflareSetup: fakeCloudflareSetup()
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("routed support@example.com to may@email.com");
    expect(aliases.find((record) => record.alias === "support")).toMatchObject({
      forwardTo: "may@email.com",
      emailCount: 0
    });
    expect(cloudflareActions).toEqual(["destination:may@email.com"]);
  });

  test("route requests verification without saving a pending destination", async () => {
    destinationStatus = "pending";

    const result = await cli(["route", "support@example.com", "may@email.com"], {
      cloudflareSetup: fakeCloudflareSetup()
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("verification pending for may@email.com");
    expect(aliases.some((record) => record.alias === "support")).toBe(false);
  });

  test("route --remove clears forwarding without deleting the alias", async () => {
    aliases.push(alias("support", { forwardTo: "may@email.com", emailCount: 0 }));

    const result = await cli(["route", "support", "--remove"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("removed route for support@example.com");
    expect(aliases.find((record) => record.alias === "support")).toMatchObject({
      forwardTo: null,
      emailCount: 0
    });
    expect(cloudflareActions).toEqual([]);
  });

  test("route --remove does not create an unseen alias", async () => {
    const result = await cli(["--exact", "route", "missing@example.com", "--remove"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no route configured");
    expect(aliases.some((record) => record.alias === "missing")).toBe(false);
  });
});

describe("outbound commands", () => {
  test("send expands a local from alias and makes exactly one request", async () => {
    const result = await cli([
      "send", "friend@example.net", "--from", "networking", "--subject", "Hello", "--text", "Body"
    ], { generateId: () => "generated-send" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sent");
    expect(requestCount.get("POST /v1/sent")).toBe(1);
    expect(sentPayloads.get("generated-send")).toMatchObject({
      version: 1,
      from: "networking@example.com",
      to: ["friend@example.net"],
      subject: "Hello",
      text: "Body"
    });
  });

  test("send accepts structured request files and preserves a supplied id", async () => {
    const body = JSON.stringify({
      id: "provided-id",
      version: 1,
      from: "networking@example.com",
      to: "friend@example.net",
      subject: "Structured",
      text: "Body"
    });
    const result = await cli(["send", "--request", "request.json"], { readFile: async () => body });

    expect(result.exitCode).toBe(0);
    expect(sentPayloads.get("provided-id")).toMatchObject({ id: "provided-id", subject: "Structured" });
  });

  test("send request expands a local from string with the global domain", async () => {
    const body = JSON.stringify({ version: 1, from: "NeTWork", to: "friend@example.net", subject: "Structured", text: "Body" });
    const result = await cli(["--domain", "Mail.Example", "send", "--request", "request.json"], {
      readFile: async () => body,
      generateId: () => "request-string"
    });

    expect(result.exitCode).toBe(0);
    expect(sentPayloads.get("request-string")).toMatchObject({ from: "network@mail.example" });
  });

  test("send request expands a local from object email with the default domain", async () => {
    const body = JSON.stringify({ version: 1, id: "request-object", from: { email: "Support", name: "Support Team" }, to: "friend@example.net", subject: "Structured", text: "Body" });
    const result = await cli(["send", "--request", "request.json"], { readFile: async () => body });

    expect(result.exitCode).toBe(0);
    expect(sentPayloads.get("request-object")).toMatchObject({ from: { email: "support@example.com", name: "Support Team" } });
  });

  test("send API failures expose the generated id without retrying", async () => {
    const result = await cli(["send", "friend@example.net", "--from", "networking", "--subject", "Hello", "--text", "Body"], {
      generateId: () => "api-fail"
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider unavailable");
    expect(result.stderr).toContain("api-fail");
    expect(requestCount.get("POST /v1/sent")).toBe(1);
  });

  test("send network failures expose the supplied request id without retrying", async () => {
    const body = JSON.stringify({ version: 1, id: "network-fail", from: "networking@example.com", to: "friend@example.net", subject: "Structured", text: "Body" });
    let attempts = 0;
    const result = await cli(["send", "--request", "request.json"], {
      readFile: async () => body,
      fetch: async () => {
        attempts += 1;
        throw new Error("offline");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network failure");
    expect(result.stderr).toContain("network-fail");
    expect(attempts).toBe(1);
  });

  test("send reads a structured request from stdin", async () => {
    const result = await cli(["send", "--request", "-"], { readFile: async (path) => {
        expect(path).toBe(0);
        return JSON.stringify({
          id: "stdin-id",
          version: 1,
          from: "networking@example.com",
          to: "friend@example.net",
          subject: "stdin",
          text: "Body"
        });
    }});

    expect(result.exitCode).toBe(0);
    expect(sentPayloads.get("stdin-id")).toMatchObject({ id: "stdin-id" });
  });

  test("reply forwards only explicit reply flags and never retries", async () => {
    const result = await cli(["reply", "01K7VTNH010000000000000000", "--text", "Thanks", "--html", "<p>Thanks</p>", "--all", "--no-quote"], { generateId: () => "reply-1" });

    expect(result.exitCode).toBe(0);
    expect(requestCount.get("POST /v1/emails/01K7VTNH010000000000000000/reply")).toBe(1);
    expect(sentPayloads.get("reply-1")).toMatchObject({ version: 1, text: "Thanks", html: "<p>Thanks</p>", replyAll: true, quote: false });
  });

  test("reply failures expose the generated send id without retrying", async () => {
    const result = await cli(["reply", "01K7VTNH010000000000000000", "--text", "Thanks"], {
      generateId: () => "reply-fail"
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider unavailable");
    expect(result.stderr).toContain("reply-fail");
    expect(requestCount.get("POST /v1/emails/01K7VTNH010000000000000000/reply")).toBe(1);
  });

  test("ls sent filters recipients and status", async () => {
    const result = await cli(["ls", "sent", "networking", "--to", "friend", "--status", "sent"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sent subject");
    expect(requestCount.get("GET /v1/sent")).toBe(1);
  });

  test("show falls back to sent only after an inbound 404 and includes its body", async () => {
    sentEmails[0]!.recipients = [
      { email: "friend@example.net", kind: "to", status: "delivered", updatedAt: 1781251320000, detail: null },
      { email: "copy@example.net", kind: "cc", status: "failed", updatedAt: 1781251320000, detail: "550 rejected" },
      { email: "blind@example.net", kind: "bcc", status: "queued", updatedAt: 1781251320000, detail: "awaiting delivery" }
    ];
    const result = await cli(["show", "sent-1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("To: friend@example.net (delivered)");
    expect(result.stdout).toContain("Cc: copy@example.net (failed: 550 rejected)");
    expect(result.stdout).toContain("Bcc: blind@example.net (queued: awaiting delivery)");
    expect(result.stdout).toContain("Sent body");
    expect(requestCount.get("GET /v1/emails/sent-1")).toBe(1);
    expect(requestCount.get("GET /v1/sent/sent-1")).toBe(1);
    expect(requestCount.get("GET /v1/sent/sent-1/payload")).toBe(1);
  });

  test("rm falls back to sent only after an inbound 404", async () => {
    const result = await cli(["rm", "sent-1"]);

    expect(result.exitCode).toBe(0);
    expect(sentEmails).toEqual([]);
    expect(requestCount.get("DELETE /v1/emails/sent-1")).toBe(1);
    expect(requestCount.get("DELETE /v1/sent/sent-1")).toBe(1);
  });

  test("show does not fall back to sent after a non-404 inbound error", async () => {
    const result = await cli(["show", "server-error"]);

    expect(result.exitCode).toBe(1);
    expect(requestCount.get("GET /v1/sent/server-error")).toBeUndefined();
  });

  test("payload prints the exact archived request JSON", async () => {
    const result = await cli(["payload", "sent-1"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(sentPayloads.get("sent-1"));
  });

  test("setup sending confirms queue creation and prints manual onboarding guidance", async () => {
    const result = await cli(["setup", "sending"], {
      confirm: async () => true,
      cloudflareSetup: { ...fakeCloudflareSetup(), ensureQueue: async (name: string) => { cloudflareActions.push(`queue:${name}`); } }
    });

    expect(result.exitCode).toBe(0);
    expect(cloudflareActions).toEqual(["login", "queue:mailsink-email-events"]);
    expect(result.stdout).toContain("Onboard Domain");
    expect(result.stdout).toContain("DMARC");
    expect(result.stdout).toContain("p=none");
    expect(result.stdout).toContain("about seven days");
    expect(result.stdout).toContain("Compute > Email Service > Email Sending");
    expect(result.stdout).toContain("Subscriptions tab");
    expect(result.stdout).toContain("cannot create an email.sending subscription");
    expect(result.stdout).toContain("mailsink send");
  });

  test("provider gmail requires an existing Gmail route and never touches a token", async () => {
    const missing = await cli(["provider", "gmail", "networking"]);
    aliases.find((record) => record.alias === "networking")!.forwardTo = "mailbox@gmail.com";
    const configured = await cli(["provider", "gmail", "networking"]);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Gmail route");
    expect(configured.exitCode).toBe(0);
    expect(configured.stdout).toContain("Cloudflare SMTP");
    expect(configured.stdout).toContain("Gmail Send mail");
    expect(configured.stdout).toContain("smtp.mx.cloudflare.net");
    expect(configured.stdout).toContain("port 465");
    expect(configured.stdout).toContain("implicit TLS");
    expect(configured.stdout).toContain("username api_token");
    expect(configured.stdout).toContain("networking@example.com");
    expect(configured.stdout).toContain("bypasses mailsink");
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
        },
        ensureDestination: async () => "verified"
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
        },
        ensureDestination: async () => "verified"
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
        },
        ensureDestination: async () => "verified"
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
        },
        ensureDestination: async () => "verified"
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
        putWorkerSecret: async (token) => { cloudflareActions.push(`secret:${token}`); },
        ensureDestination: async () => "verified"
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("API URL is required");
    expect(cloudflareActions).toEqual(["login"]);
    expect(savedConfig).toBeNull();
    expect(savedToken).toBeNull();
  });
});

describe("Cloudflare destination output", () => {
  test("distinguishes missing, pending, and verified addresses", async () => {
    const status = (await import("../src/index")).destinationStatusFromWrangler;
    expect(status?.("No destination addresses found.\n", "may@email.com")).toBe("missing");
    expect(status?.(
      "│ abc │ may@email.com │ pending              │ 2026-07-28 │\n",
      "may@email.com"
    )).toBe("pending");
    expect(status?.(
      "│ abc │ may@email.com │ 2026-07-28T08:00:00Z │ 2026-07-28 │\n",
      "may@email.com"
    )).toBe("verified");
    expect(status?.(
      "│ abc │ notmay@email.com │ 2026-07-28T08:00:00Z │ 2026-07-28 │\n",
      "may@email.com"
    )).toBe("missing");
    expect(status?.(
      "│ abc │ pending@email.com │ 2026-07-28T08:00:00Z │ 2026-07-28 │\n",
      "pending@email.com"
    )).toBe("verified");
  });

  test("queue setup uses account-level Wrangler commands without a worker cwd", async () => {
    const createSetup = (await import("../src/index") as Record<string, unknown>).createWranglerCloudflareSetup;
    expect(createSetup).toBeTypeOf("function");
    if (typeof createSetup !== "function") return;
    const calls: string[][] = [];
    const setup = (createSetup as (run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>) => { ensureQueue(name: string): Promise<void> })(async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args[0] === "queues" && args[1] === "list" ? "No queues found\n" : "", stderr: "" };
    });

    await setup.ensureQueue("mailsink-email-events");

    expect(calls).toEqual([
      ["whoami", "--json"],
      ["queues", "list"],
      ["queues", "create", "mailsink-email-events"]
    ]);
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
  const requestKey = `${request.method} ${url.pathname}`;
  requestCount.set(requestKey, (requestCount.get(requestKey) ?? 0) + 1);

  if (url.pathname === "/v1/aliases" && request.method === "GET") {
    const query = url.searchParams.get("q");
    const status = url.searchParams.get("status");
    const domain = url.searchParams.get("domain");
    const routed = url.searchParams.get("routed");
    return json({
      aliases: aliases.filter((record) =>
        (!query || record.alias.includes(query)) &&
        (!status || record.status === status) &&
        (!domain || record.domain === domain) &&
        (routed !== "true" || record.forwardTo !== null)
      )
    });
  }

  if (url.pathname.startsWith("/v1/aliases/") && request.method === "PATCH") {
    const [, , , domain, aliasName] = url.pathname.split("/") as [string, string, string, string, string];
    const body = await request.json() as {
      status?: "active" | "blocked";
      note?: string | null;
      forwardTo?: string | null;
    };
    const existing = aliases.find((record) => record.alias === aliasName && record.domain === domain);
    if (existing) {
      if (body.status !== undefined) existing.status = body.status;
      if ("note" in body) existing.note = body.note ?? null;
      if ("forwardTo" in body) existing.forwardTo = body.forwardTo ?? null;
      return json(existing);
    }
    const record = alias(aliasName!, {
      domain,
      status: body.status ?? "active",
      note: body.note ?? null,
      forwardTo: body.forwardTo ?? null,
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

  if (url.pathname === "/v1/sent" && request.method === "POST") {
    const payload = await request.json() as Record<string, unknown>;
    const id = payload.id as string;
    if (id === "api-fail") return json({ error: { code: "internal", message: "provider unavailable" } }, 502);
    const fromAddr = typeof payload.from === "string" ? payload.from : (payload.from as { email: string }).email;
    const [aliasName, domain] = fromAddr.split("@") as [string, string];
    const recipients = (Array.isArray(payload.to) ? payload.to : [payload.to]).map((email) => ({
      email: typeof email === "string" ? email : (email as { email: string }).email,
      kind: "to",
      status: "queued",
      updatedAt: 1781251500000,
      detail: null
    }));
    const sent = {
      id,
      alias: aliasName,
      domain,
      fromAddr,
      recipients,
      status: "queued",
      subject: payload.subject,
      createdAt: 1781251500000,
      updatedAt: 1781251500000,
      messageId: null,
      errorCode: null,
      errorMessage: null,
      recipientCount: recipients.length
    };
    sentEmails.push(sent);
    sentPayloads.set(id, payload);
    return json(sent);
  }

  if (url.pathname === "/v1/sent" && request.method === "GET") {
    const aliasName = url.searchParams.get("alias");
    const domain = url.searchParams.get("domain");
    const to = url.searchParams.get("to");
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    return json({
      emails: sentEmails.filter((email) =>
        (!aliasName || email.alias === aliasName) &&
        (!domain || email.domain === domain) &&
        (!status || email.status === status) &&
        (!to || (email.recipients as Array<{ email: string }>).some((recipient) => recipient.email.includes(to)))
      ).slice(0, limit),
      cursor: null
    });
  }

  if (url.pathname === "/v1/sent" && request.method === "DELETE") {
    const aliasName = url.searchParams.get("alias");
    const domain = url.searchParams.get("domain");
    const before = sentEmails.length;
    sentEmails = sentEmails.filter((email) => email.alias !== aliasName || email.domain !== domain);
    return json({ deleted: before - sentEmails.length });
  }

  const sentMatch = url.pathname.match(/^\/v1\/sent\/([^/]+)$/);
  if (sentMatch && request.method === "GET") {
    const sent = sentEmails.find((candidate) => candidate.id === sentMatch[1]);
    return sent ? json(sent) : json({ error: { code: "not_found", message: "sent email not found" } }, 404);
  }
  if (sentMatch && request.method === "DELETE") {
    const before = sentEmails.length;
    sentEmails = sentEmails.filter((message) => message.id !== sentMatch[1]);
    return json({ deleted: before - sentEmails.length });
  }

  const payloadMatch = url.pathname.match(/^\/v1\/sent\/([^/]+)\/payload$/);
  if (payloadMatch && request.method === "GET") {
    const payload = sentPayloads.get(payloadMatch[1]!);
    return payload ? json(payload) : json({ error: { code: "not_found", message: "sent payload not found" } }, 404);
  }

  const emailMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)$/);
  if (emailMatch && request.method === "GET") {
    if (emailMatch[1] === "server-error") return json({ error: { code: "internal", message: "server error" } }, 500);
    const message = emails.find((candidate) => candidate.id === emailMatch[1]);
    return message ? json(message) : json({ error: { code: "not_found", message: "email not found" } }, 404);
  }
  if (emailMatch && request.method === "DELETE") {
    const existing = emails.some((candidate) => candidate.id === emailMatch[1]);
    if (!existing) return json({ error: { code: "not_found", message: "email not found" } }, 404);
    const before = emails.length;
    emails = emails.filter((message) => message.id !== emailMatch[1]);
    return json({ deleted: before - emails.length });
  }

  const rawMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)\/raw$/);
  if (rawMatch && request.method === "GET") {
    return new Response(raws.get(rawMatch[1]!) ?? "", { status: 200 });
  }

  const replyMatch = url.pathname.match(/^\/v1\/emails\/([^/]+)\/reply$/);
  if (replyMatch && request.method === "POST") {
    const payload = await request.json() as Record<string, unknown>;
    if (payload.id === "reply-fail") return json({ error: { code: "internal", message: "provider unavailable" } }, 502);
    const sent = {
      id: payload.id,
      alias: "networking",
      domain: "example.com",
      fromAddr: "networking@example.com",
      recipients: [{ email: "sender@example.net", kind: "to", status: "queued", updatedAt: 1781251500000, detail: null }],
      status: "queued",
      subject: "Re: Coffee?",
      createdAt: 1781251500000,
      updatedAt: 1781251500000,
      messageId: null,
      errorCode: null,
      errorMessage: null,
      recipientCount: 1
    };
    sentEmails.push(sent);
    sentPayloads.set(payload.id as string, payload);
    return json(sent);
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
    forwardTo: fields.forwardTo ?? null,
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
    forwardTo: fields.forwardTo ?? null,
    forwardError: fields.forwardError ?? null,
    textBody: "textBody" in fields ? fields.textBody! : "body"
  };
}

function fakeCloudflareSetup() {
  return {
    ensureLogin: async () => { cloudflareActions.push("login"); },
    logout: async () => { cloudflareActions.push("logout"); },
    whoami: async () => "user@example.com\n",
    putWorkerSecret: async (value: string) => { cloudflareActions.push(`secret:${value}`); },
    ensureDestination: async (emailAddress: string) => {
      cloudflareActions.push(`destination:${emailAddress}`);
      return destinationStatus;
    }
  };
}
