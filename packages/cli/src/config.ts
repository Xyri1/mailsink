import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Entry } from "@napi-rs/keyring";

export interface CliConfig {
  url: string;
  defaultDomain: string;
}

export interface ConfigStore {
  read(): Promise<CliConfig | null>;
  write(config: CliConfig): Promise<void>;
}

export interface CredentialStore {
  readToken(): Promise<string | null>;
  writeToken(token: string): Promise<void>;
}

export interface RuntimeConfig extends CliConfig {
  token: string;
}

export class CliFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliFailure";
  }
}

export function createFileConfigStore(env: Record<string, string | undefined> = process.env): ConfigStore {
  const path = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mailsink", "config.json");
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as CliConfig;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(config) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
  };
}

export function createKeyringCredentialStore(): CredentialStore {
  return {
    async readToken() {
      return new Entry("mailsink", "api-token").getPassword();
    },
    async writeToken(token) {
      new Entry("mailsink", "api-token").setPassword(token);
    }
  };
}

export async function loadRuntimeConfig(
  configStore: ConfigStore,
  credentialStore: CredentialStore,
  env: Record<string, string | undefined>
): Promise<RuntimeConfig> {
  const fileConfig = await configStore.read();
  const url = env.MAILSINK_URL ?? fileConfig?.url;
  const token = env.MAILSINK_TOKEN ?? await credentialStore.readToken();
  const defaultDomain = fileConfig?.defaultDomain;

  if (!url || !defaultDomain || !token) {
    throw new CliFailure("missing config; run mailsink init");
  }

  return { url, defaultDomain, token };
}
