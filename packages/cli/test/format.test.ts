import { expect, test } from "vitest";
import { formatEmailList, formatEmailWithBody } from "../src/format";

test("formats relative times, HTML-only messages, and parse warnings", () => {
  const now = 1781251500000;

  expect(formatEmailList([{
    id: "01K7VTNH010000000000000000",
    alias: "netflix-x7f2",
    domain: "example.com",
    toAddr: "netflix-x7f2@example.com",
    envelopeFrom: "bounce@example.net",
    fromAddr: "sender@example.net",
    fromName: "Sender",
    subject: "Subject",
    dateHeader: now - 120_000,
    receivedAt: now - 120_000,
    sizeBytes: 20,
    hasHtml: false,
    attachmentCount: 0,
    parseError: true,
    forwardTo: null,
    forwardError: null
  }], { now, color: false })).toMatch(/2m ago\s+!\s+netflix-x7f2@example.com\s+Sender Subject/);

  expect(formatEmailWithBody({
    id: "01K7VTNH010000000000000000",
    alias: "netflix-x7f2",
    domain: "example.com",
    toAddr: "netflix-x7f2@example.com",
    envelopeFrom: "bounce@example.net",
    fromAddr: "sender@example.net",
    fromName: "Sender",
    subject: "Subject",
    dateHeader: now,
    receivedAt: now,
    sizeBytes: 20,
    hasHtml: true,
    attachmentCount: 1,
    parseError: false,
    forwardTo: "may@email.com",
    forwardError: "forward unavailable",
    textBody: null
  }, { now, color: false })).toContain(
    "Route: may@email.com\nForward error: forward unavailable\n\nHTML-only message; mailsink raw 01K7VTNH010000000000000000 for the original"
  );
});
