require("dotenv").config();

const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { createDatabase } = require("../lib/database");
const { initDatabaseSchema } = require("../lib/schema");

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows || []);
    });
  });
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row || null);
    });
  });
}

function sqliteClose(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

async function pgRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ id: this?.lastID ?? null, changes: this?.changes ?? 0 });
    });
  });
}

async function sqliteTableExists(db, tableName) {
  const row = await sqliteGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName]
  );
  return Boolean(row?.name);
}

async function sqliteTableColumns(db, tableName) {
  const rows = await sqliteAll(db, `PRAGMA table_info(${tableName})`);
  return new Set((rows || []).map((row) => row.name));
}

async function copyTableRows(sourceDb, targetDb, tableName, columns) {
  const tableExists = await sqliteTableExists(sourceDb, tableName);
  if (!tableExists) {
    console.log(`Tabela ${tableName}: ausente na origem, pulando.`);
    return;
  }

  const sourceColumns = await sqliteTableColumns(sourceDb, tableName);
  const availableColumns = columns.filter((column) => sourceColumns.has(column));

  if (!availableColumns.length) {
    console.log(`Tabela ${tableName}: sem colunas compatíveis na origem, pulando.`);
    return;
  }

  const rows = await sqliteAll(
    sourceDb,
    `SELECT ${availableColumns.join(", ")} FROM ${tableName} ORDER BY ${availableColumns.includes("id") ? "id" : availableColumns[0]}`
  );

  if (!rows.length) {
    console.log(`Tabela ${tableName}: 0 registro(s)`);
    return;
  }

  const placeholders = availableColumns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${tableName} (${availableColumns.join(", ")}) VALUES (${placeholders})`;

  for (const row of rows) {
    await pgRun(targetDb, sql, availableColumns.map((column) => row[column]));
  }

  const missingColumns = columns.filter((column) => !sourceColumns.has(column));
  if (missingColumns.length) {
    console.log(
      `Tabela ${tableName}: ${rows.length} registro(s) migrado(s) com defaults para coluna(s) ausente(s): ${missingColumns.join(", ")}`
    );
    return;
  }

  console.log(`Tabela ${tableName}: ${rows.length} registro(s) migrado(s)`);
}

async function resetPostgresSequences(targetDb) {
  const tables = [
    "usuarios",
    "itens",
    "almoxarifado_itens",
    "obras",
    "funcionarios",
    "movimentacoes",
    "almoxarifado_movimentacoes",
    "auditoria_acoes"
  ];

  for (const table of tables) {
    await pgRun(targetDb, `
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1),
        (SELECT COUNT(*) > 0 FROM ${table})
      )
    `);
  }
}

async function main() {
  const runtimeBaseDir = process.env.UNIQSTOCK_RUNTIME_DIR
    ? path.resolve(process.env.UNIQSTOCK_RUNTIME_DIR)
    : path.resolve(__dirname, "..");
  const sqliteFile = process.env.SQLITE_SOURCE_PATH
    ? path.resolve(process.env.SQLITE_SOURCE_PATH)
    : path.join(runtimeBaseDir, "db", "inventario.db");

  console.log(`Origem SQLite: ${sqliteFile}`);

  const sourceDb = new sqlite3.Database(sqliteFile);

  const originalDbClient = process.env.DB_CLIENT;
  process.env.DB_CLIENT = "postgres";
  const targetDb = createDatabase({ sqliteFile: path.join(runtimeBaseDir, "db", "inventario.db") });

  try {
    await initDatabaseSchema(targetDb);

    await targetDb.withTransaction(async () => {
      await pgRun(targetDb, `
        TRUNCATE TABLE
          movimentacoes,
          almoxarifado_movimentacoes,
          auditoria_acoes,
          permissoes_usuarios,
          funcionarios,
          obras,
          almoxarifado_itens,
          itens,
          usuarios,
          configuracoes
        RESTART IDENTITY CASCADE
      `);

      await copyTableRows(sourceDb, targetDb, "usuarios", ["id", "usuario", "senha", "perfil"]);
      await copyTableRows(sourceDb, targetDb, "itens", ["id", "codigo", "ferramenta", "categoria", "marca_modelo", "quantidade_total", "localizacao", "estado_inicial", "observacao"]);
      await copyTableRows(sourceDb, targetDb, "almoxarifado_itens", [
        "id",
        "codigo",
        "ferramenta",
        "categoria",
        "marca_modelo",
        "quantidade_total",
        "unidade_medida",
        "embalagem",
        "estoque_minimo",
        "fornecedor",
        "localizacao",
        "estado_inicial",
        "observacao"
      ]);
      await copyTableRows(sourceDb, targetDb, "configuracoes", ["chave", "valor"]);
      await copyTableRows(sourceDb, targetDb, "obras", ["id", "nome", "responsavel"]);
      await copyTableRows(sourceDb, targetDb, "funcionarios", ["id", "nome", "matricula", "funcao"]);
      await copyTableRows(sourceDb, targetDb, "permissoes_usuarios", [
        "user_id",
        "ver_dashboard",
        "ver_inventario",
        "criar_editar_itens",
        "criar_itens",
        "editar_itens",
        "excluir_itens",
        "ver_etiquetas",
        "usar_scanner",
        "ver_movimentacoes",
        "registrar_movimentacao",
        "importar_exportar",
        "gerenciar_usuarios"
      ]);
      await copyTableRows(sourceDb, targetDb, "auditoria_acoes", ["id", "data", "usuario", "acao", "entidade", "entidade_id", "detalhes"]);
      await copyTableRows(sourceDb, targetDb, "movimentacoes", ["id", "data", "item_id", "tipo", "quantidade", "obra", "funcionario", "observacao"]);
      await copyTableRows(sourceDb, targetDb, "almoxarifado_movimentacoes", [
        "id",
        "data",
        "item_id",
        "tipo",
        "quantidade",
        "obra",
        "funcionario",
        "observacao"
      ]);

      await resetPostgresSequences(targetDb);
    });

    console.log("Migração SQLite -> Postgres concluída.");
  } finally {
    await sqliteClose(sourceDb).catch(() => {});
    await new Promise((resolve) => targetDb.close(() => resolve()));
    if (originalDbClient === undefined) {
      delete process.env.DB_CLIENT;
    } else {
      process.env.DB_CLIENT = originalDbClient;
    }
  }
}

main().catch((error) => {
  console.error("Falha na migração SQLite -> Postgres:", error.message);
  process.exitCode = 1;
});
