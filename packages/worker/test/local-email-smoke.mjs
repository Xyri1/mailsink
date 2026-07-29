import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const workerDir = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

test("wrangler dev handles inbound and simulated outbound email locally", { timeout: 60_000 }, async () => {
  const persistTo = await mkdtemp(join(tmpdir(), "mailsink-local-email-"));
  let output = "";
  let dev;

  try {
    await exec(wrangler, [
      "d1", "migrations", "apply", "mailsink-local-test",
      "--local",
      "--persist-to", persistTo,
      "--config", "wrangler.test.jsonc"
    ], { cwd: workerDir });

    dev = execFile(wrangler, [
      "dev",
      "--local",
      "--persist-to", persistTo,
      "--config", "wrangler.test.jsonc",
      "--port", "0"
    ], { cwd: workerDir });
    dev.stdout?.on("data", (chunk) => { output += chunk; });
    dev.stderr?.on("data", (chunk) => { output += chunk; });
    await waitFor(() => /Ready on http:\/\/localhost:\d+/.test(output), () => output);
    const port = Number(output.match(/Ready on http:\/\/localhost:(\d+)/)?.[1]);
    assert.ok(port);

    const fixture = await readFile(new URL("./fixtures/plain.eml", import.meta.url));
    const inbound = await fetch(
      `http://localhost:${port}/cdn-cgi/handler/email?from=no-reply%40em.netflix.com&to=netflix-x7f2%40example.com`,
      {
        method: "POST",
        headers: { "Content-Type": "message/rfc822" },
        body: fixture
      }
    );
    assert.equal(inbound.status, 200);

    const listed = await api(port, "/v1/emails?alias=netflix-x7f2&domain=example.com&include=body");
    assert.equal(listed.status, 200);
    const inbox = await listed.json();
    assert.equal(inbox.emails.length, 1);
    assert.equal(inbox.emails[0].subject, "Your sign-in code");
    assert.equal(inbox.emails[0].textBody.trim(), "Your code is 123456.");

    const sent = await api(port, "/v1/sent", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        id: "local-send-1",
        from: "sender@example.com",
        to: "recipient@example.net",
        subject: "Local simulation",
        text: "plain local body",
        html: "<p>html local body</p>"
      })
    });
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).status, "accepted");

    await waitFor(
      () => /Text:\s+[^\r\n]+\.txt/.test(output) && /HTML:\s+[^\r\n]+\.html/.test(output),
      () => output
    );
    const textPath = output.match(/Text:\s+([^\r\n]+\.txt)/)?.[1];
    const htmlPath = output.match(/HTML:\s+([^\r\n]+\.html)/)?.[1];
    assert.ok(textPath);
    assert.ok(htmlPath);
    assert.equal(await readFile(textPath, "utf8"), "plain local body");
    assert.equal(await readFile(htmlPath, "utf8"), "<p>html local body</p>");

    const payload = await api(port, "/v1/sent/local-send-1/payload");
    assert.equal(payload.status, 200);
    assert.deepEqual(await payload.json(), {
      version: 1,
      id: "local-send-1",
      from: "sender@example.com",
      to: "recipient@example.net",
      subject: "Local simulation",
      text: "plain local body",
      html: "<p>html local body</p>"
    });
  } finally {
    if (dev && dev.exitCode === null) {
      const exited = once(dev, "exit");
      dev.kill("SIGINT");
      const force = setTimeout(() => dev.kill("SIGKILL"), 1_000);
      await exited;
      clearTimeout(force);
    }
    await rm(persistTo, { recursive: true, force: true });
  }
});

function api(port, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-token");
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(`http://localhost:${port}${path}`, { ...init, headers });
}

async function waitFor(predicate, diagnostic) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 20_000) {
      throw new Error(`Timed out waiting for Wrangler output:\n${diagnostic().slice(-4_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
