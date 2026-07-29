#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as readFileFromFd } from "node:fs";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import {
  CliFailure,
  type CliConfig,
  type ConfigStore,
  type CredentialStore,
  createFileConfigStore,
  createKeyringCredentialStore,
  loadRuntimeConfig
} from "./config";
import { type Fetch, MailsinkApiError, MailsinkClient, MailsinkNetworkError } from "./client";
import { formatAliases, formatEmailList, formatEmailWithBody, formatRoutes, formatSentEmailList, formatSentEmailWithBody } from "./format";
import { parseAliasQuery, resolveOneWriteAlias, resolveReadAliases } from "./resolve";
import type { AliasRecord, EmailSummary, EmailWithBody, ReplyEmailRequest, SendEmailRequest } from "@mailsink/shared";

interface InitAnswers {
  url: string;
  token?: string;
  defaultDomain: string;
}

interface CloudflareSetup {
  ensureLogin(): Promise<void>;
  logout(): Promise<void>;
  whoami(): Promise<string>;
  putWorkerSecret(token: string): Promise<void>;
  ensureDestination(email: string): Promise<"verified" | "pending">;
  ensureQueue?(name: string): Promise<void>;
}

interface InitPromptMode {
  askToken: boolean;
}

export interface CliDeps {
  configStore?: ConfigStore;
  credentialStore?: CredentialStore;
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  prompts?: (mode: InitPromptMode) => Promise<InitAnswers>;
  confirm?: (message: string) => Promise<boolean>;
  writeFile?: (path: string, data: string) => Promise<void>;
  readFile?: (path: string | number) => Promise<string>;
  generateToken?: () => string;
  generateId?: () => string;
  cloudflareSetup?: CloudflareSetup;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandContext {
  deps: Required<Omit<CliDeps, "fetch">> & { fetch: Fetch };
  stdout: string[];
  stderr: string[];
}

export async function runCli(args: string[], deps: CliDeps = {}): Promise<CliResult> {
  const context: CommandContext = {
    deps: {
      configStore: deps.configStore ?? createFileConfigStore(deps.env ?? process.env),
      credentialStore: deps.credentialStore ?? createKeyringCredentialStore(),
      fetch: deps.fetch ?? fetch,
      env: deps.env ?? process.env,
      now: deps.now ?? Date.now,
      prompts: deps.prompts ?? promptInit,
      confirm: deps.confirm ?? confirmPrompt,
      writeFile: deps.writeFile ?? writeFile,
      readFile: deps.readFile ?? readRequestFile,
      generateToken: deps.generateToken ?? generateApiToken,
      generateId: deps.generateId ?? randomUUID,
      cloudflareSetup: deps.cloudflareSetup ?? createWranglerCloudflareSetup()
    },
    stdout: [],
    stderr: []
  };

  const program = buildProgram(context);
  try {
    await program.parseAsync(args, { from: "user" });
    return { exitCode: 0, stdout: context.stdout.join(""), stderr: context.stderr.join("") };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { exitCode: error.exitCode, stdout: context.stdout.join(""), stderr: context.stderr.join("") };
    }
    const message = formatError(error);
    context.stderr.push(`${message}\n`);
    return { exitCode: 1, stdout: context.stdout.join(""), stderr: context.stderr.join("") };
  }
}

function buildProgram(context: CommandContext) {
  const program = new Command();
  program
    .name("mailsink")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.stdout.push(value),
      writeErr: (value) => context.stderr.push(value)
    })
    .option("--json", "emit raw API response")
    .option("--domain <domain>", "override the configured default domain")
    .option("--exact", "treat alias query as exact");

  program.command("init").option("--cloudflare", "use Wrangler browser login to create and store the Worker API token").action(async (options) => {
    if (options.cloudflare) await context.deps.cloudflareSetup.ensureLogin();
    const answers = await context.deps.prompts({ askToken: !options.cloudflare });
    validateInitAnswers(answers, { requireToken: !options.cloudflare });
    const url = normalizeApiUrl(answers.url);
    const token = options.cloudflare ? await createCloudflareToken(context) : requirePromptedToken(answers.token);
    const client = new MailsinkClient(url, token, context.deps.fetch);
    await client.listAliases({ limit: 1 });
    const config: CliConfig = { url, defaultDomain: answers.defaultDomain };
    await context.deps.configStore.write(config);
    await context.deps.credentialStore.writeToken(token);
    context.stdout.push(options.cloudflare ? "initialized mailsink with Cloudflare-assisted setup\n" : "initialized mailsink\n");
  });

  program.command("login").description("log in to Cloudflare through Wrangler's browser flow").action(async () => {
    await context.deps.cloudflareSetup.ensureLogin();
    context.stdout.push("logged in to Cloudflare\n");
  });

  program.command("logout").description("log out of Cloudflare through Wrangler").action(async () => {
    await context.deps.cloudflareSetup.logout();
    context.stdout.push("logged out of Cloudflare\n");
  });

  program.command("whoami").description("show the current Cloudflare Wrangler session").action(async () => {
    context.stdout.push(await context.deps.cloudflareSetup.whoami());
  });

  program.command("latest <query>").option("--from <sender>").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const aliases = await resolveReadAliases(client, query, runtime.defaultDomain, globals);
    const messages = await Promise.all(aliases.map(async (record) => {
      const response = await client.listEmails({
        alias: record.alias,
        domain: record.domain,
        from: options.from,
        limit: 1,
        includeBody: true
      });
      return response.emails[0] as EmailWithBody | undefined;
    }));
    const found = messages.filter((message): message is EmailWithBody => message !== undefined);
    if (globals.json) return writeJson(context, { emails: found });
    if (found.length === 0) throw new CliFailure(`no email found for ${query}`);
    writeHuman(context, found.map((message) => `${message.alias}@${message.domain}\n${formatEmailWithBody(message, formatOptions(context))}`).join("\n\n"));
  });

  const ls = program.command("ls");
  ls.command("inbox [alias]").option("--from <sender>").option("--limit <n>").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const limit = parseLimit(options.limit, 20);
    let emails: EmailSummary[];
    if (query) {
      const aliases = await resolveReadAliases(client, query, runtime.defaultDomain, globals);
      const responses = await Promise.all(aliases.map((record) => client.listEmails({
        alias: record.alias,
        domain: record.domain,
        from: options.from,
        limit
      })));
      emails = responses.flatMap((response) => response.emails as EmailSummary[])
        .sort((left, right) => right.receivedAt - left.receivedAt)
        .slice(0, limit);
    } else {
      emails = (await client.listEmails({ domain: globals.domain ?? runtime.defaultDomain, from: options.from, limit })).emails as EmailSummary[];
    }
    if (globals.json) return writeJson(context, { emails, cursor: null });
    writeHuman(context, formatEmailList(emails, formatOptions(context)));
  });

  ls.command("sent [alias]").option("--to <recipient>").option("--status <state>").option("--limit <n>").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const limit = parseLimit(options.limit, 20);
    const parsed = query ? parseAliasQuery(query, runtime.defaultDomain, globals.domain) : null;
    const response = await client.listSentEmails({
      ...(parsed ? { alias: parsed.alias, domain: parsed.domain } : { domain: globals.domain ?? runtime.defaultDomain }),
      to: options.to,
      status: options.status,
      limit
    });
    if (globals.json) return writeJson(context, response);
    writeHuman(context, formatSentEmailList(response.emails, formatOptions(context)));
  });

  program.command("send [recipients...]")
    .option("--from <alias|address>")
    .option("--subject <subject>")
    .option("--text <text>")
    .option("--request <file|->")
    .action(async (recipients: string[], options) => {
      const { runtime, client, globals } = await commandRuntime(program, context);
      const request = options.request
        ? await readSendRequest(context, options.request, runtime.defaultDomain, globals.domain)
        : commonSendRequest(recipients, options as { from?: string; subject?: string; text?: string }, runtime.defaultDomain, globals.domain, context.deps.generateId);
      let sent;
      try {
        sent = await client.sendEmail(request);
      } catch (error) {
        throw new CliFailure(`${formatError(error)}; send id ${request.id}`);
      }
      if (globals.json) return writeJson(context, sent);
      context.stdout.push(`sent ${sent.id}\n`);
    });

  program.command("reply <inbound-id>")
    .requiredOption("--text <text>")
    .option("--html <html>")
    .option("--all")
    .option("--no-quote")
    .action(async (inboundId, options) => {
      const { client, globals } = await commandRuntime(program, context);
      const request: ReplyEmailRequest = {
        version: 1,
        id: context.deps.generateId(),
        text: options.text,
        ...(options.html === undefined ? {} : { html: options.html }),
        ...(options.all ? { replyAll: true } : {}),
        ...(options.quote === false ? { quote: false } : {})
      };
      let sent;
      try {
        sent = await client.replyEmail(inboundId, request);
      } catch (error) {
        throw new CliFailure(`${formatError(error)}; send id ${request.id}`);
      }
      if (globals.json) return writeJson(context, sent);
      context.stdout.push(`sent ${sent.id}\n`);
    });

  program.command("show <id>").action(async (id) => {
    const { client, globals } = await commandRuntime(program, context);
    try {
      const email = await client.getEmail(id);
      if (globals.json) return writeJson(context, email);
      return writeHuman(context, formatEmailWithBody(email, formatOptions(context)));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const sent = await client.getSentEmail(id);
    if (globals.json) return writeJson(context, sent);
    const payload = await client.getSentPayload(id);
    writeHuman(context, formatSentEmailWithBody(sent, payload));
  });

  program.command("payload <sent-id>").action(async (id) => {
    const { client } = await commandRuntime(program, context);
    writeJson(context, await client.getSentPayload(id));
  });

  program.command("raw <id>").option("-o, --output <file>").action(async (id, options) => {
    const { client } = await commandRuntime(program, context);
    const raw = await client.getRawEmail(id);
    if (options.output) {
      await context.deps.writeFile(options.output, raw);
      context.stdout.push(`wrote ${options.output}\n`);
    } else {
      context.stdout.push(raw);
    }
  });

  program.command("burn <alias>").action(async (query) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, { ...globals, allowPreBlock: true });
    const updated = await client.patchAlias(record.domain, record.alias, { status: "blocked", note: record.note });
    if (globals.json) return writeJson(context, updated);
    context.stdout.push(`blocked ${updated.alias}@${updated.domain}\n`);
  });

  program.command("unburn <alias>").action(async (query) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, globals);
    const updated = await client.patchAlias(record.domain, record.alias, { status: "active", note: record.note });
    if (globals.json) return writeJson(context, updated);
    context.stdout.push(`unblocked ${updated.alias}@${updated.domain}\n`);
  });

  program.command("aliases [query]").option("--blocked").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const parsedDomain = globals.domain ?? runtime.defaultDomain;
    const response = await client.listAliases({
      ...(query ? { q: query } : {}),
      domain: parsedDomain,
      ...(options.blocked ? { status: "blocked" as const } : {})
    });
    if (globals.json) return writeJson(context, response);
    writeHuman(context, formatAliases(response.aliases, formatOptions(context)));
  });

  program.command("note <alias> <text>").action(async (query, text) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, globals);
    const updated = await client.patchAlias(record.domain, record.alias, { status: record.status, note: text });
    if (globals.json) return writeJson(context, updated);
    context.stdout.push(`noted ${updated.alias}@${updated.domain}\n`);
  });

  program.command("route [query] [destination]").option("--remove").action(async (query, destination, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    if (!destination && !options.remove) {
      const parsed = query ? parseAliasQuery(query, runtime.defaultDomain, globals.domain) : null;
      const response = await client.listAliases({
        ...(parsed ? { q: parsed.alias, domain: parsed.domain } : { domain: globals.domain ?? runtime.defaultDomain }),
        routed: true
      });
      if (globals.json) return writeJson(context, response);
      return writeHuman(context, formatRoutes(response.aliases));
    }

    if (!query) throw new CliFailure("alias is required");
    if (destination && options.remove) throw new CliFailure("destination and --remove cannot be used together");
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, {
      ...globals,
      allowPreBlock: Boolean(destination)
    });

    if (options.remove) {
      if (!record.forwardTo) throw new CliFailure(`no route configured for ${record.alias}@${record.domain}`);
      const updated = await client.patchAlias(record.domain, record.alias, { forwardTo: null });
      if (globals.json) return writeJson(context, updated);
      context.stdout.push(`removed route for ${updated.alias}@${updated.domain}\n`);
      return;
    }

    const forwardTo = destination.trim();
    if (await context.deps.cloudflareSetup.ensureDestination(forwardTo) === "pending") {
      throw new CliFailure(`verification pending for ${forwardTo}; verify the Cloudflare email, then rerun this command`);
    }
    const updated = await client.patchAlias(record.domain, record.alias, { forwardTo });
    if (globals.json) return writeJson(context, updated);
    context.stdout.push(`routed ${updated.alias}@${updated.domain} to ${updated.forwardTo}\n`);
  });

  program.command("rm <id>").action(async (id) => {
    const { client, globals } = await commandRuntime(program, context);
    let response;
    try {
      response = await client.deleteEmail(id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      response = await client.deleteSentEmail(id);
    }
    if (globals.json) return writeJson(context, response);
    context.stdout.push(`deleted ${response.deleted} email\n`);
  });

  const purge = program.command("purge");
  purge.command("inbox <alias>").option("--yes").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, globals);
    if (!options.yes && !await context.deps.confirm(`Delete all mail for ${record.alias}@${record.domain}?`)) {
      throw new CliFailure("cancelled");
    }
    const response = await client.deleteEmailsByAlias(record.alias, record.domain);
    if (globals.json) return writeJson(context, response);
    context.stdout.push(`deleted ${response.deleted} emails from ${record.alias}@${record.domain}\n`);
  });

  purge.command("sent <alias>").option("--yes").action(async (query, options) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = parseAliasQuery(query, runtime.defaultDomain, globals.domain);
    if (!options.yes && !await context.deps.confirm(`Delete all sent mail from ${record.label}?`)) {
      throw new CliFailure("cancelled");
    }
    const response = await client.deleteSentEmailsByAlias(record.alias, record.domain);
    if (globals.json) return writeJson(context, response);
    context.stdout.push(`deleted ${response.deleted} sent email${response.deleted === 1 ? "" : "s"} from ${record.label}\n`);
  });

  const setup = program.command("setup");
  setup.command("sending [domain]").action(async (domain) => {
    const { runtime } = await commandRuntime(program, context);
    const sendingDomain = domain ?? runtime.defaultDomain;
    if (!await context.deps.confirm(`Set up outbound sending for ${sendingDomain}?`)) throw new CliFailure("cancelled");
    await context.deps.cloudflareSetup.ensureLogin();
    if (!context.deps.cloudflareSetup.ensureQueue) throw new CliFailure("Cloudflare queue setup is unavailable");
    await context.deps.cloudflareSetup.ensureQueue("mailsink-email-events");
    writeHuman(context, [
      `Queue mailsink-email-events is ready for ${sendingDomain}.`,
      "In the Cloudflare dashboard, open Compute > Email Service > Email Sending, select Onboard Domain, and verify its DNS records.",
      "Then select mailsink-email-events on the Queues page and create a domain-scoped event subscription on its Subscriptions tab.",
      "Add DMARC only if no record exists; start with p=none and do not overwrite an existing DMARC record.",
      "The bundled Wrangler cannot create an email.sending subscription. Use the dashboard or REST API.",
      "Email preview is retained for about seven days. Verify Worker queue configuration and deploy your Worker before use.",
      `Run a controlled test when ready: mailsink send recipient@example.com --from sender@${sendingDomain} --subject test --text test`
    ].join("\n"));
  });

  const provider = program.command("provider");
  provider.command("gmail <alias>").action(async (query) => {
    const { runtime, client, globals } = await commandRuntime(program, context);
    const record = await resolveOneWriteAlias(client, query, runtime.defaultDomain, globals);
    if (!record.forwardTo || !/@(?:gmail|googlemail)\.com$/i.test(record.forwardTo)) {
      throw new CliFailure(`a Gmail route is required for ${record.alias}@${record.domain}`);
    }
    writeHuman(context, [
      `Use Cloudflare SMTP with Gmail Send mail for ${record.alias}@${record.domain}.`,
      `SMTP host smtp.mx.cloudflare.net, port 465, implicit TLS, username api_token, and selected alias ${record.alias}@${record.domain}.`,
      "Create the Cloudflare SMTP token manually in the dashboard; mailsink never reads, stores, or prints it.",
      "Gmail-sent mail bypasses mailsink and does not appear in mailsink ls sent."
    ].join("\n"));
  });

  return program;
}

async function commandRuntime(program: Command, context: CommandContext) {
  const globals = program.opts<{ json?: boolean; domain?: string; exact?: boolean }>();
  const runtime = await loadRuntimeConfig(context.deps.configStore, context.deps.credentialStore, context.deps.env);
  return {
    runtime,
    globals,
    client: new MailsinkClient(runtime.url, runtime.token, context.deps.fetch)
  };
}

function writeJson(context: CommandContext, value: unknown) {
  context.stdout.push(`${JSON.stringify(value)}\n`);
}

function writeHuman(context: CommandContext, value: string) {
  if (value.length > 0) context.stdout.push(`${value}\n`);
}

function parseLimit(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliFailure("limit must be a positive integer");
  return parsed;
}

function commonSendRequest(
  recipients: string[],
  options: { from?: string; subject?: string; text?: string },
  defaultDomain: string,
  domain: string | undefined,
  generateId: () => string
): SendEmailRequest {
  if (recipients.length === 0) throw new CliFailure("at least one recipient is required");
  if (!options.from) throw new CliFailure("from is required");
  if (!options.subject) throw new CliFailure("subject is required");
  if (options.text === undefined) throw new CliFailure("text is required");
  return {
    version: 1,
    id: generateId(),
    from: parseAliasQuery(options.from, defaultDomain, domain).label,
    to: recipients,
    subject: options.subject,
    text: options.text
  };
}

async function readSendRequest(context: CommandContext, file: string, defaultDomain: string, domain?: string): Promise<SendEmailRequest> {
  try {
    const request = JSON.parse(await context.deps.readFile(file === "-" ? 0 : file)) as SendEmailRequest;
    request.id ??= context.deps.generateId();
    if (typeof request.from === "string") {
      request.from = parseAliasQuery(request.from, defaultDomain, domain).label;
    } else {
      request.from = { ...request.from, email: parseAliasQuery(request.from.email, defaultDomain, domain).label };
    }
    return request;
  } catch (error) {
    throw new CliFailure(`invalid send request: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNotFound(error: unknown) {
  return error instanceof MailsinkApiError && error.status === 404;
}

function readRequestFile(path: string | number): Promise<string> {
  if (typeof path === "string") return readFile(path, "utf8");
  return new Promise((resolve, reject) => {
    readFileFromFd(path, "utf8", (error, data) => error ? reject(error) : resolve(data));
  });
}

function formatOptions(context: CommandContext) {
  return { now: context.deps.now(), color: Boolean(process.stdout.isTTY) };
}

function formatError(error: unknown) {
  if (error instanceof MailsinkApiError) {
    return error.status === 401 ? `${error.message}; token rejected - re-run mailsink init` : error.message;
  }
  if (error instanceof MailsinkNetworkError || error instanceof CliFailure || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function createCloudflareToken(context: CommandContext) {
  const token = context.deps.generateToken();
  await context.deps.cloudflareSetup.putWorkerSecret(token);
  return token;
}

function requirePromptedToken(token: string | undefined) {
  if (!token) throw new CliFailure("API token is required");
  return token;
}

function validateInitAnswers(answers: InitAnswers, options: { requireToken: boolean }) {
  if (!answers.url.trim()) throw new CliFailure("API URL is required");
  if (!answers.defaultDomain.trim()) throw new CliFailure("default domain is required");
  if (options.requireToken && !answers.token?.trim()) throw new CliFailure("API token is required");
}

function normalizeApiUrl(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function generateApiToken() {
  return randomBytes(32).toString("base64url");
}

export function createWranglerCloudflareSetup(run: typeof runWrangler = runWrangler): CloudflareSetup {
  const workerDir = findWorkerDir();
  const ensureLogin = async () => {
    const whoami = await run(["whoami", "--json"]);
    if (whoami.exitCode === 0) return;

    const login = await run(["login"], { inherit: true });
    if (login.exitCode !== 0) {
      throw new CliFailure("Cloudflare browser login failed");
    }
  };
  return {
    ensureLogin,
    async logout() {
      const result = await run(["logout"], { inherit: true });
      if (result.exitCode !== 0) {
        throw new CliFailure("Cloudflare logout failed");
      }
    },
    async whoami() {
      const result = await run(["whoami"]);
      if (result.exitCode !== 0) {
        throw new CliFailure(`Cloudflare whoami failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return result.stdout;
    },
    async putWorkerSecret(token) {
      const result = await run(["secret", "put", "API_TOKEN", "--cwd", workerDir], { input: `${token}\n` });
      if (result.exitCode !== 0) {
        throw new CliFailure(`failed to upload API_TOKEN with Wrangler: ${result.stderr.trim() || result.stdout.trim()}`);
      }
    },
    async ensureDestination(email) {
      await ensureLogin();
      const listed = await run(["email", "routing", "addresses", "list", "--cwd", workerDir]);
      if (listed.exitCode !== 0) {
        throw new CliFailure(`failed to list Cloudflare destination addresses: ${listed.stderr.trim() || listed.stdout.trim()}`);
      }
      const status = destinationStatusFromWrangler(listed.stdout, email);
      if (status !== "missing") return status;

      const created = await run(["email", "routing", "addresses", "create", email, "--cwd", workerDir]);
      if (created.exitCode !== 0) {
        throw new CliFailure(`failed to create Cloudflare destination address: ${created.stderr.trim() || created.stdout.trim()}`);
      }
      return "pending";
    },
    async ensureQueue(name) {
      await ensureLogin();
      const listed = await run(["queues", "list"]);
      if (listed.exitCode !== 0) {
        throw new CliFailure(`failed to list Cloudflare queues: ${listed.stderr.trim() || listed.stdout.trim()}`);
      }
      if (listed.stdout.split("\n").some((line) => line.split(/[│|]/).some((column) => column.trim() === name))) return;
      const created = await run(["queues", "create", name]);
      if (created.exitCode !== 0) {
        throw new CliFailure(`failed to create Cloudflare queue ${name}: ${created.stderr.trim() || created.stdout.trim()}`);
      }
    }
  };
}

export function destinationStatusFromWrangler(output: string, email: string): "missing" | "pending" | "verified" {
  const target = email.toLowerCase();
  for (const line of output.split("\n")) {
    const columns = line.split(/[│|]/).map((column) => column.trim());
    const emailColumn = columns.findIndex((column) => column.toLowerCase() === target);
    if (emailColumn !== -1) return columns[emailColumn + 1]?.toLowerCase() === "pending" ? "pending" : "verified";
  }
  return "missing";
}

function findWorkerDir() {
  const candidates = [
    resolve("packages", "worker"),
    resolve("..", "worker"),
    resolve(import.meta.dirname, "..", "..", "worker")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function runWrangler(args: string[], options: { input?: string; inherit?: boolean } = {}) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolveProcess, reject) => {
    const child = spawn(npxCommand(), ["wrangler", ...args], {
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    if (!options.inherit) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.stdin?.end(options.input);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolveProcess({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function promptInit(mode: InitPromptMode): Promise<InitAnswers> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const url = await prompt.question("API URL:");
  const token = mode.askToken ? await prompt.question("API token:") : "";
  const defaultDomain = await prompt.question("Default domain:");
  prompt.close();
  return mode.askToken ? { url, token, defaultDomain } : { url, defaultDomain };
}

async function confirmPrompt(message: string) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${message} [y/N]`);
  prompt.close();
  return answer.toLowerCase() === "y";
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
