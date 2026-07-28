import { describe, expect, test } from "vitest";
import { mapAliasRow, mapEmailRow, normalizeRecipient, ulidFloor } from "../src/core";

describe("recipient normalization", () => {
  test("lowercases the domain and folds subaddress tags into the base alias", () => {
    expect(normalizeRecipient("Netflix-X7F2+login@Example.COM")).toEqual({
      alias: "netflix-x7f2",
      domain: "example.com",
      toAddr: "Netflix-X7F2+login@Example.COM"
    });
  });
});

describe("row mapping", () => {
  test("maps snake_case email rows to the shared camelCase API contract", () => {
    expect(mapEmailRow({
      id: "01J00000000000000000000000",
      alias: "netflix-x7f2",
      domain: "example.com",
      to_addr: "Netflix-X7F2@example.com",
      envelope_from: "bounce@sender.example",
      from_addr: "no-reply@em.netflix.com",
      from_name: "Netflix",
      subject: "Your sign-in code",
      date_header: 1781251200000,
      received_at: 1781251210000,
      size_bytes: 178,
      text_body: "Your code is 123456.",
      has_html: 0,
      attachment_count: 0,
      parse_error: 0,
      r2_key: "example.com/netflix-x7f2/01J00000000000000000000000.eml",
      forward_to: "me@example.net",
      forward_error: null
    }, true)).toEqual({
      id: "01J00000000000000000000000",
      alias: "netflix-x7f2",
      domain: "example.com",
      toAddr: "Netflix-X7F2@example.com",
      envelopeFrom: "bounce@sender.example",
      fromAddr: "no-reply@em.netflix.com",
      fromName: "Netflix",
      subject: "Your sign-in code",
      dateHeader: 1781251200000,
      receivedAt: 1781251210000,
      sizeBytes: 178,
      textBody: "Your code is 123456.",
      hasHtml: false,
      attachmentCount: 0,
      parseError: false,
      forwardTo: "me@example.net",
      forwardError: null
    });
  });

  test("maps alias rows without inventing defaults", () => {
    expect(mapAliasRow({
      alias: "github",
      domain: "example.com",
      status: "blocked",
      note: null,
      forward_to: "me@example.net",
      first_seen_at: 1781251200000,
      last_seen_at: 1781251300000,
      email_count: 7
    })).toEqual({
      alias: "github",
      domain: "example.com",
      status: "blocked",
      note: null,
      forwardTo: "me@example.net",
      firstSeenAt: 1781251200000,
      lastSeenAt: 1781251300000,
      emailCount: 7
    });
  });
});

describe("ulid floor", () => {
  test("returns a timestamp floor that sorts before generated ULIDs from the same millisecond", () => {
    expect(ulidFloor(1781251200000)).toBe("01KTXDGN000000000000000000");
  });
});
