CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT,
  from_addr    TEXT NOT NULL,
  from_name    TEXT,
  to_addr      TEXT,
  subject      TEXT,
  date         TEXT,
  body_text    TEXT,
  body_html    TEXT,
  raw_size     INTEGER,
  attach_count INTEGER DEFAULT 0,
  attach_meta  TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_created ON emails(created_at DESC);
