import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fakes";

class FakeEmailMessage {
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  rejected: string | null = null;

  constructor(public from: string, public to: string, body: string) {
    const bytes = new TextEncoder().encode(body);
    this.rawSize = bytes.byteLength;
    this.raw = new Response(bytes).body!;
  }

  setReject(reason: string) {
    this.rejected = reason;
  }
}

const plain = await readFile(new URL("./fixtures/plain.eml", import.meta.url), "utf8");

describe("email ingest", () => {
  test("stores raw first, parses metadata, and upserts the implicit alias", async () => {
    const env = makeEnv();
    const message = new FakeEmailMessage("bounce@em.netflix.com", "Netflix-X7F2+login@Example.COM", plain);

    await worker.email(message, env);

    expect(message.rejected).toBeNull();
    expect([...env.RAW.objects.keys()]).toHaveLength(1);
    const row = [...env.DB.emails.values()][0];
    expect(row).toMatchObject({
      alias: "netflix-x7f2",
      domain: "example.com",
      to_addr: "Netflix-X7F2+login@Example.COM",
      envelope_from: "bounce@em.netflix.com",
      from_addr: "no-reply@em.netflix.com",
      from_name: "Netflix",
      subject: "Your sign-in code",
      has_html: 0,
      attachment_count: 0,
      parse_error: 0
    });
    expect(String(row?.text_body).trim()).toBe("Your code is 123456.");
    expect(env.DB.aliases.get(env.DB.aliasKey("netflix-x7f2", "example.com"))?.email_count).toBe(1);
  });

  test("rejects blocked aliases without storing raw or metadata", async () => {
    const env = makeEnv();
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: null,
      first_seen_at: 1781251200000,
      last_seen_at: 1781251200000,
      email_count: 0
    });
    const message = new FakeEmailMessage("spammer@example.net", "netflix-x7f2+spam@example.com", plain);

    await worker.email(message, env);

    expect(message.rejected).toBe("address unavailable");
    expect(env.RAW.objects.size).toBe(0);
    expect(env.DB.emails.size).toBe(0);
  });

  test("drop mode silently ignores blocked aliases", async () => {
    const env = makeEnv({ BLOCK_MODE: "drop" });
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: null,
      first_seen_at: 1781251200000,
      last_seen_at: 1781251200000,
      email_count: 0
    });
    const message = new FakeEmailMessage("spammer@example.net", "netflix-x7f2@example.com", plain);

    await worker.email(message, env);

    expect(message.rejected).toBeNull();
    expect(env.RAW.objects.size).toBe(0);
  });
});
