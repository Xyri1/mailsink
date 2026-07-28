CREATE TABLE aliases (
  alias          TEXT    NOT NULL,
  domain         TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'blocked')),
  note           TEXT,
  forward_to     TEXT,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  email_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (alias, domain)
);

CREATE TABLE emails (
  id               TEXT    PRIMARY KEY,
  alias            TEXT    NOT NULL,
  domain           TEXT    NOT NULL,
  to_addr          TEXT    NOT NULL,
  envelope_from    TEXT    NOT NULL,
  from_addr        TEXT    NOT NULL,
  from_name        TEXT,
  subject          TEXT,
  date_header      INTEGER,
  received_at      INTEGER NOT NULL,
  size_bytes       INTEGER NOT NULL,
  text_body        TEXT,
  has_html         INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  parse_error      INTEGER NOT NULL DEFAULT 0,
  r2_key           TEXT    NOT NULL,
  forward_to       TEXT,
  forward_error    TEXT
);

CREATE INDEX idx_emails_alias ON emails (alias, domain, id DESC);
