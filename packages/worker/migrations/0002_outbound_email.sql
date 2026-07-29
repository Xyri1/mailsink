ALTER TABLE emails ADD COLUMN html_body TEXT;
ALTER TABLE emails ADD COLUMN message_id TEXT;
ALTER TABLE emails ADD COLUMN reply_to TEXT;
ALTER TABLE emails ADD COLUMN references_header TEXT;
ALTER TABLE emails ADD COLUMN to_header TEXT;
ALTER TABLE emails ADD COLUMN cc_header TEXT;

CREATE TABLE sent_emails (
  id              TEXT    PRIMARY KEY,
  alias           TEXT    NOT NULL,
  domain          TEXT    NOT NULL,
  from_addr       TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  message_id      TEXT,
  error_code      TEXT,
  error_message   TEXT,
  recipient_count INTEGER NOT NULL,
  r2_key          TEXT    NOT NULL
);

CREATE TABLE sent_recipients (
  sent_id    TEXT    NOT NULL REFERENCES sent_emails(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  status     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  detail     TEXT,
  PRIMARY KEY (sent_id, email)
);

CREATE INDEX idx_sent_sender ON sent_emails (alias, domain, created_at DESC, id DESC);
CREATE INDEX idx_sent_message ON sent_emails (message_id);
CREATE INDEX idx_sent_recipient ON sent_recipients (email, sent_id);
