const { runDb } = require("./db");

async function initFilesSchema(db) {
  if (db.client === "postgres") {
    await initPostgresSchema(db);
    return;
  }

  await initSqliteSchema(db);
}

async function initSqliteSchema(db) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS ucf_files (
      id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      owner_type TEXT,
      owner_ref TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      extension TEXT,
      size_bytes INTEGER NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      public_slug TEXT NOT NULL UNIQUE,
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);

  await runDb(db, `
    CREATE INDEX IF NOT EXISTS idx_ucf_files_owner
    ON ucf_files (owner_type, owner_ref)
  `);

  await runDb(db, `
    CREATE INDEX IF NOT EXISTS idx_ucf_files_bucket
    ON ucf_files (bucket)
  `);
}

async function initPostgresSchema(db) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS ucf_files (
      id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      owner_type TEXT,
      owner_ref TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      extension TEXT,
      size_bytes BIGINT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      public_slug TEXT NOT NULL UNIQUE,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP
    )
  `);

  await runDb(db, `
    CREATE INDEX IF NOT EXISTS idx_ucf_files_owner
    ON ucf_files (owner_type, owner_ref)
  `);

  await runDb(db, `
    CREATE INDEX IF NOT EXISTS idx_ucf_files_bucket
    ON ucf_files (bucket)
  `);
}

module.exports = {
  initFilesSchema
};
