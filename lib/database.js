const sqlite3 = require("sqlite3").verbose();
const { AsyncLocalStorage } = require("async_hooks");

let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (_) {}

const postgresContext = new AsyncLocalStorage();
const POSTGRES_TABLES_WITH_ID = new Set([
  "usuarios",
  "itens",
  "almoxarifado_itens",
  "obras",
  "funcionarios",
  "movimentacoes",
  "almoxarifado_movimentacoes",
  "auditoria_acoes"
]);

function createDatabase({ sqliteFile }) {
  const client = String(process.env.DB_CLIENT || "sqlite").trim().toLowerCase();

  if (client === "postgres") {
    if (!Pool) {
      throw new Error("Pacote 'pg' não encontrado. Instale a dependência para usar Postgres.");
    }

    const connectionString = process.env.DATABASE_URL || "";
    const pool = connectionString
      ? new Pool({ connectionString })
      : new Pool({
          host: process.env.PGHOST || "localhost",
          port: Number(process.env.PGPORT || 5432),
          database: process.env.PGDATABASE || "uniqstock",
          user: process.env.PGUSER || "postgres",
          password: process.env.PGPASSWORD || ""
        });

    return {
      client: "postgres",
      pool,
      run(sql, params = [], callback) {
        const cb = typeof params === "function" ? params : callback;
        const values = Array.isArray(params) ? params : [];
        const query = translatePostgresQuery(sql);
        const executor = postgresContext.getStore() || pool;

        executor.query(query.text, query.values(values))
          .then((result) => {
            cb?.call(
              {
                lastID: result.rows?.[0]?.id ?? null,
                changes: result.rowCount ?? 0
              },
              null
            );
          })
          .catch((error) => cb?.(error));
      },
      get(sql, params = [], callback) {
        const cb = typeof params === "function" ? params : callback;
        const values = Array.isArray(params) ? params : [];
        const query = translatePostgresQuery(sql);
        const executor = postgresContext.getStore() || pool;

        executor.query(query.text, query.values(values))
          .then((result) => cb?.(null, result.rows?.[0]))
          .catch((error) => cb?.(error));
      },
      all(sql, params = [], callback) {
        const cb = typeof params === "function" ? params : callback;
        const values = Array.isArray(params) ? params : [];
        const query = translatePostgresQuery(sql);
        const executor = postgresContext.getStore() || pool;

        executor.query(query.text, query.values(values))
          .then((result) => cb?.(null, result.rows || []))
          .catch((error) => cb?.(error));
      },
      serialize(fn) {
        fn();
      },
      async withTransaction(fn) {
        const clientConn = await pool.connect();
        try {
          await clientConn.query("BEGIN");
          const result = await postgresContext.run(clientConn, fn);
          await clientConn.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await clientConn.query("ROLLBACK");
          } catch (_) {}
          throw error;
        } finally {
          clientConn.release();
        }
      },
      close(callback) {
        pool.end().then(() => callback?.()).catch((error) => callback?.(error));
      }
    };
  }

  const sqlite = new sqlite3.Database(sqliteFile);
  return {
    client: "sqlite",
    raw: sqlite,
    run: sqlite.run.bind(sqlite),
    get: sqlite.get.bind(sqlite),
    all: sqlite.all.bind(sqlite),
    serialize: sqlite.serialize.bind(sqlite),
    withTransaction: async (fn) => {
      await new Promise((resolve, reject) => {
        sqlite.run("BEGIN TRANSACTION", (error) => {
          if (error) return reject(error);
          resolve();
        });
      });
      try {
        const result = await fn();
        await new Promise((resolve, reject) => {
          sqlite.run("COMMIT", (error) => {
            if (error) return reject(error);
            resolve();
          });
        });
        return result;
      } catch (error) {
        try {
          await new Promise((resolve, reject) => {
            sqlite.run("ROLLBACK", (rollbackError) => {
              if (rollbackError) return reject(rollbackError);
              resolve();
            });
          });
        } catch (_) {}
        throw error;
      }
    },
    close: sqlite.close.bind(sqlite)
  };
}

function translatePostgresQuery(sql) {
  let source = String(sql || "");

  if (/^\s*PRAGMA\s+table_info\(([^)]+)\)/i.test(source)) {
    const [, tableNameRaw] = source.match(/^\s*PRAGMA\s+table_info\(([^)]+)\)/i);
    const tableName = tableNameRaw.replace(/^["'`]|["'`]$/g, "").trim();
    return {
      text: `
        SELECT
          ordinal_position - 1 AS cid,
          column_name AS name,
          data_type AS type,
          CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
          column_default AS dflt_value,
          0 AS pk
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
      values: () => [tableName]
    };
  }

  source = source.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");

  if (/^\s*INSERT\s+INTO\b/i.test(source) && !/\bON\s+CONFLICT\b/i.test(source)) {
    const tableMatch = source.match(/^\s*INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    const tableName = tableMatch?.[1]?.toLowerCase() || "";
    if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(String(sql || ""))) {
      source = `${source} ON CONFLICT DO NOTHING`;
    } else if (POSTGRES_TABLES_WITH_ID.has(tableName) && !/\bRETURNING\b/i.test(source)) {
      source = `${source} RETURNING id`;
    }
  }

  let index = 0;
  const translated = source.replace(/\?/g, () => `$${++index}`);
  return {
    text: translated,
    values: (params) => params
  };
}

module.exports = {
  createDatabase
};
