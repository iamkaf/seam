export const seamD1Schema = `
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at TEXT,
  last_op_id TEXT NOT NULL
) STRICT;

CREATE INDEX idx_records_scope_type_id
  ON records(scope_kind, scope_id, type, id);

CREATE INDEX idx_records_active_list
  ON records(scope_kind, scope_id, type, id)
  WHERE deleted_at IS NULL;

CREATE TABLE seq_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  mutation_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  version INTEGER NOT NULL,
  hint TEXT
) STRICT;

CREATE INDEX idx_seq_scope
  ON seq_log(scope_kind, scope_id, seq);

CREATE INDEX idx_seq_op
  ON seq_log(op_id, seq);

CREATE UNIQUE INDEX idx_seq_op_record
  ON seq_log(op_id, record_id);

CREATE TABLE seam_batch_assertions (
  op_id TEXT NOT NULL,
  step TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY(op_id, step)
) STRICT;

CREATE TABLE mutation_receipts (
  actor_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, client_mutation_id)
) STRICT;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  record_type TEXT,
  record_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_outbox_seq ON outbox(seq);
`;
