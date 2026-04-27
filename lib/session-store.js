function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ id: this?.lastID ?? null, changes: this?.changes ?? 0 });
    });
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveExpiresAtMs(sessionData, fallbackMaxAgeMs) {
  const cookie = sessionData?.cookie || {};
  const expiresAt = cookie.expires ? new Date(cookie.expires).getTime() : null;
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }

  const originalMaxAge = Number(cookie.originalMaxAge);
  if (Number.isFinite(originalMaxAge) && originalMaxAge > 0) {
    return Date.now() + originalMaxAge;
  }

  return Date.now() + fallbackMaxAgeMs;
}

async function ensureSessionTable(db, tableName) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      sid TEXT PRIMARY KEY,
      sess_json TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runDb(
    db,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at_ms ON ${tableName} (expires_at_ms)`
  );
}

function createPersistentSessionStore(session, db, options = {}) {
  const tableName = String(options.tableName || "app_sessions").trim() || "app_sessions";
  const sessionMaxAgeMs = normalizePositiveNumber(
    options.sessionMaxAgeMs,
    12 * 60 * 60 * 1000
  );
  const cleanupIntervalMs = normalizePositiveNumber(
    options.cleanupIntervalMs,
    30 * 60 * 1000
  );
  const ready = ensureSessionTable(db, tableName);

  class DatabaseSessionStore extends session.Store {
    constructor() {
      super();
      this.tableName = tableName;
      this.ready = ready;
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired(() => {});
      }, cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }

    async get(sid, callback = () => {}) {
      try {
        await this.ready;
        const row = await getDb(
          db,
          `SELECT sess_json, expires_at_ms FROM ${this.tableName} WHERE sid = ?`,
          [sid]
        );

        if (!row) {
          return callback(null, null);
        }

        if (Number(row.expires_at_ms) <= Date.now()) {
          await runDb(db, `DELETE FROM ${this.tableName} WHERE sid = ?`, [sid]);
          return callback(null, null);
        }

        return callback(null, JSON.parse(row.sess_json));
      } catch (error) {
        return callback(error);
      }
    }

    async set(sid, sessionData, callback = () => {}) {
      try {
        await this.ready;
        const payload = JSON.stringify(sessionData);
        const expiresAtMs = resolveExpiresAtMs(sessionData, sessionMaxAgeMs);
        const updatedAt = new Date().toISOString();

        await runDb(
          db,
          `
            INSERT INTO ${this.tableName} (sid, sess_json, expires_at_ms, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET
              sess_json = excluded.sess_json,
              expires_at_ms = excluded.expires_at_ms,
              updated_at = excluded.updated_at
          `,
          [sid, payload, expiresAtMs, updatedAt]
        );

        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    async touch(sid, sessionData, callback = () => {}) {
      try {
        await this.ready;
        const payload = JSON.stringify(sessionData);
        const expiresAtMs = resolveExpiresAtMs(sessionData, sessionMaxAgeMs);
        const updatedAt = new Date().toISOString();

        await runDb(
          db,
          `
            UPDATE ${this.tableName}
            SET sess_json = ?, expires_at_ms = ?, updated_at = ?
            WHERE sid = ?
          `,
          [payload, expiresAtMs, updatedAt, sid]
        );

        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    async destroy(sid, callback = () => {}) {
      try {
        await this.ready;
        await runDb(db, `DELETE FROM ${this.tableName} WHERE sid = ?`, [sid]);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    async cleanupExpired(callback = () => {}) {
      try {
        await this.ready;
        await runDb(
          db,
          `DELETE FROM ${this.tableName} WHERE expires_at_ms <= ?`,
          [Date.now()]
        );
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    close() {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }
  }

  return {
    store: new DatabaseSessionStore(),
    ready
  };
}

module.exports = {
  createPersistentSessionStore
};
