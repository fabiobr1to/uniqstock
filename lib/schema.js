const bcrypt = require("bcryptjs");

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
      resolve(row);
    });
  });
}

function allDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function obterSenhaBootstrapAdmin() {
  const senhaEnv = String(process.env.UNIQSTOCK_ADMIN_PASSWORD || "").trim();
  return senhaEnv || "admin123";
}

function senhaEhHashBcrypt(valor) {
  return typeof valor === "string" && valor.startsWith("$2");
}

async function migrarSenhasLegadasParaHash(db) {
  const usuarios = await allDb(db, `SELECT id, senha FROM usuarios WHERE senha IS NOT NULL AND TRIM(senha) <> ''`);
  let totalMigrado = 0;

  for (const usuario of usuarios) {
    if (senhaEhHashBcrypt(usuario.senha)) continue;

    const hash = await bcrypt.hash(String(usuario.senha), 10);
    await runDb(db, `UPDATE usuarios SET senha = ? WHERE id = ?`, [hash, usuario.id]);
    totalMigrado++;
  }

  if (totalMigrado > 0) {
    console.log(`Migracao de seguranca: ${totalMigrado} senha(s) legada(s) convertida(s) para hash bcrypt.`);
  }
}

async function initDatabaseSchema(db) {
  if (db.client === "postgres") {
    await initPostgresSchema(db);
    return;
  }

  await initSqliteSchema(db);
}

async function initSqliteSchema(db) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      perfil TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      ferramenta TEXT NOT NULL,
      categoria TEXT,
      marca_modelo TEXT,
      quantidade_total REAL DEFAULT 0,
      localizacao TEXT,
      estado_inicial TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS almoxarifado_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      ferramenta TEXT NOT NULL,
      categoria TEXT,
      marca_modelo TEXT,
      quantidade_total REAL DEFAULT 0,
      unidade_medida TEXT,
      embalagem TEXT,
      estoque_minimo REAL DEFAULT 0,
      fornecedor TEXT,
      localizacao TEXT,
      estado_inicial TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS obras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      responsavel TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      matricula TEXT,
      funcao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS movimentacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT DEFAULT (datetime('now', 'localtime')),
      item_id INTEGER NOT NULL,
      tipo TEXT CHECK(tipo IN ('ENTRADA','SAIDA')) NOT NULL,
      quantidade REAL NOT NULL,
      obra TEXT,
      funcionario TEXT,
      observacao TEXT,
      FOREIGN KEY(item_id) REFERENCES itens(id)
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS almoxarifado_movimentacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT DEFAULT (datetime('now', 'localtime')),
      item_id INTEGER NOT NULL,
      tipo TEXT CHECK(tipo IN ('ENTRADA','SAIDA')) NOT NULL,
      quantidade REAL NOT NULL,
      obra TEXT,
      funcionario TEXT,
      observacao TEXT,
      FOREIGN KEY(item_id) REFERENCES almoxarifado_itens(id)
    )
  `);

  const colsAlmox = await allDb(db, `PRAGMA table_info(almoxarifado_itens)`);
  const colunasAlmox = new Set((colsAlmox || []).map((c) => c.name));
  const migracoesAlmox = [
    ["unidade_medida", "ALTER TABLE almoxarifado_itens ADD COLUMN unidade_medida TEXT"],
    ["embalagem", "ALTER TABLE almoxarifado_itens ADD COLUMN embalagem TEXT"],
    ["estoque_minimo", "ALTER TABLE almoxarifado_itens ADD COLUMN estoque_minimo REAL DEFAULT 0"],
    ["fornecedor", "ALTER TABLE almoxarifado_itens ADD COLUMN fornecedor TEXT"]
  ];

  for (const [nome, sql] of migracoesAlmox) {
    if (!colunasAlmox.has(nome)) {
      try {
        await runDb(db, sql);
      } catch (error) {
        console.error(`Erro ao criar coluna ${nome} em almoxarifado_itens:`, error.message);
      }
    }
  }

  const postgresAlmoxColumns = [
    ["unidade_medida", "TEXT"],
    ["embalagem", "TEXT"],
    ["estoque_minimo", "DOUBLE PRECISION DEFAULT 0"],
    ["fornecedor", "TEXT"]
  ];

  for (const [columnName, columnType] of postgresAlmoxColumns) {
    try {
      await runDb(db, `ALTER TABLE almoxarifado_itens ADD COLUMN ${columnName} ${columnType}`);
    } catch (_) {}
  }

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS permissoes_usuarios (
      user_id INTEGER PRIMARY KEY,
      ver_dashboard INTEGER DEFAULT 1,
      ver_inventario INTEGER DEFAULT 1,
      criar_editar_itens INTEGER DEFAULT 0,
      criar_itens INTEGER DEFAULT 0,
      editar_itens INTEGER DEFAULT 0,
      excluir_itens INTEGER DEFAULT 0,
      ver_etiquetas INTEGER DEFAULT 1,
      usar_scanner INTEGER DEFAULT 1,
      ver_movimentacoes INTEGER DEFAULT 1,
      registrar_movimentacao INTEGER DEFAULT 0,
      importar_exportar INTEGER DEFAULT 0,
      gerenciar_usuarios INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES usuarios(id)
    )
  `);

  const cols = await allDb(db, `PRAGMA table_info(permissoes_usuarios)`);
  const colunas = new Set((cols || []).map((c) => c.name));
  const migracoes = [
    ["criar_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN criar_itens INTEGER DEFAULT 0"],
    ["editar_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN editar_itens INTEGER DEFAULT 0"],
    ["excluir_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN excluir_itens INTEGER DEFAULT 0"]
  ];

  for (const [nome, sql] of migracoes) {
    if (!colunas.has(nome)) {
      try {
        await runDb(db, sql);
      } catch (error) {
        console.error(`Erro ao criar coluna ${nome}:`, error.message);
      }
    }
  }

  try {
    await runDb(db, `
      UPDATE permissoes_usuarios
      SET
        criar_itens = CASE
          WHEN COALESCE(criar_itens, 0) = 0 AND COALESCE(criar_editar_itens, 0) = 1 THEN 1
          ELSE COALESCE(criar_itens, 0)
        END,
        editar_itens = CASE
          WHEN COALESCE(editar_itens, 0) = 0 AND COALESCE(criar_editar_itens, 0) = 1 THEN 1
          ELSE COALESCE(editar_itens, 0)
        END,
        excluir_itens = CASE
          WHEN COALESCE(excluir_itens, 0) = 0 AND COALESCE(criar_editar_itens, 0) = 1 THEN 1
          ELSE COALESCE(excluir_itens, 0)
        END
    `);
  } catch (error) {
    console.error("Erro ao atualizar permissões legadas:", error.message);
  }

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS auditoria_acoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT DEFAULT (datetime('now', 'localtime')),
      usuario TEXT,
      acao TEXT NOT NULL,
      entidade TEXT NOT NULL,
      entidade_id INTEGER,
      detalhes TEXT
    )
  `);

  try {
    const result = await runDb(db, `
      UPDATE auditoria_acoes
      SET entidade_id = (
        SELECT u.id
        FROM usuarios u
        WHERE u.usuario = auditoria_acoes.usuario
        LIMIT 1
      )
      WHERE entidade = 'auth'
        AND acao LIKE 'LOGIN_%'
        AND (entidade_id IS NULL OR entidade_id = '')
        AND EXISTS (
          SELECT 1
          FROM usuarios u2
          WHERE u2.usuario = auditoria_acoes.usuario
        )
    `);
    if (result.changes > 0) {
      console.log(`Migração auditoria login: ${result.changes} registro(s) atualizados.`);
    }
  } catch (error) {
    console.error("Erro na migração de auditoria de login:", error.message);
  }

  const sequencia = await getDb(db, `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_item'`);
  if (!sequencia) {
    await runDb(db, `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)`, ["sequencia_codigo_item", "1"]);
  }

  const sequenciaAlmox = await getDb(db, `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_almox_item'`);
  if (!sequenciaAlmox) {
    await runDb(db, `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)`, ["sequencia_codigo_almox_item", "1"]);
  }

  await runDb(db, `
    INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES
      ('backup_auto_habilitado', '1'),
      ('backup_auto_horario', '02:00'),
      ('backup_reter_dias', '15'),
      ('estoque_baixo_limite', '2'),
      ('licenca_ativa', '0'),
      ('licenca_chave', ''),
      ('licenca_cliente', ''),
      ('licenca_expira_em', ''),
      ('licenca_ativada_em', ''),
      ('licenca_cache_cliente', ''),
      ('licenca_cache_expira_em', ''),
      ('licenca_cache_machine_code', ''),
      ('licenca_cache_validada_em', ''),
      ('categorias_customizadas', '[]'),
      ('localizacoes_customizadas', '[]'),
      ('sequencia_codigo_almox_item', '1')
  `);

  await migrarSenhasLegadasParaHash(db);

  const admin = await getDb(db, `SELECT * FROM usuarios WHERE usuario = ?`, ["admin"]);
  if (!admin) {
    const senhaAdminBootstrap = obterSenhaBootstrapAdmin();
    const hashAdminBootstrap = await bcrypt.hash(senhaAdminBootstrap, 10);
    await runDb(db, `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`, ["admin", hashAdminBootstrap, "admin"]);
    console.log("Usuario admin bootstrap criado. Altere a senha imediatamente apos o primeiro acesso.");
    const novoAdmin = await getDb(db, `SELECT id FROM usuarios WHERE usuario = ?`, ["admin"]);
    if (novoAdmin?.id) {
      await runDb(db, `
        INSERT OR IGNORE INTO permissoes_usuarios (
          user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
          usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
        ) VALUES (?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
      `, [novoAdmin.id]);
    }
  }
}

async function initPostgresSchema(db) {
  await runDb(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      usuario TEXT UNIQUE,
      senha TEXT,
      perfil TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS itens (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      codigo TEXT UNIQUE,
      ferramenta TEXT NOT NULL,
      categoria TEXT,
      marca_modelo TEXT,
      quantidade_total DOUBLE PRECISION DEFAULT 0,
      localizacao TEXT,
      estado_inicial TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS almoxarifado_itens (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      codigo TEXT UNIQUE,
      ferramenta TEXT NOT NULL,
      categoria TEXT,
      marca_modelo TEXT,
      quantidade_total DOUBLE PRECISION DEFAULT 0,
      unidade_medida TEXT,
      embalagem TEXT,
      estoque_minimo DOUBLE PRECISION DEFAULT 0,
      fornecedor TEXT,
      localizacao TEXT,
      estado_inicial TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS obras (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      nome TEXT,
      responsavel TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      nome TEXT,
      matricula TEXT,
      funcao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS movimentacoes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      item_id INTEGER NOT NULL REFERENCES itens(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA','SAIDA')),
      quantidade DOUBLE PRECISION NOT NULL,
      obra TEXT,
      funcionario TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS almoxarifado_movimentacoes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      item_id INTEGER NOT NULL REFERENCES almoxarifado_itens(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA','SAIDA')),
      quantidade DOUBLE PRECISION NOT NULL,
      obra TEXT,
      funcionario TEXT,
      observacao TEXT
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS permissoes_usuarios (
      user_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
      ver_dashboard INTEGER DEFAULT 1,
      ver_inventario INTEGER DEFAULT 1,
      criar_editar_itens INTEGER DEFAULT 0,
      criar_itens INTEGER DEFAULT 0,
      editar_itens INTEGER DEFAULT 0,
      excluir_itens INTEGER DEFAULT 0,
      ver_etiquetas INTEGER DEFAULT 1,
      usar_scanner INTEGER DEFAULT 1,
      ver_movimentacoes INTEGER DEFAULT 1,
      registrar_movimentacao INTEGER DEFAULT 0,
      importar_exportar INTEGER DEFAULT 0,
      gerenciar_usuarios INTEGER DEFAULT 0
    )
  `);

  await runDb(db, `
    CREATE TABLE IF NOT EXISTS auditoria_acoes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      usuario TEXT,
      acao TEXT NOT NULL,
      entidade TEXT NOT NULL,
      entidade_id INTEGER,
      detalhes TEXT
    )
  `);

  await runDb(db, `
    INSERT INTO configuracoes (chave, valor) VALUES
      ('sequencia_codigo_item', '1'),
      ('backup_auto_habilitado', '1'),
      ('backup_auto_horario', '02:00'),
      ('backup_reter_dias', '15'),
      ('estoque_baixo_limite', '2'),
      ('licenca_ativa', '0'),
      ('licenca_chave', ''),
      ('licenca_cliente', ''),
      ('licenca_expira_em', ''),
      ('licenca_ativada_em', ''),
      ('licenca_cache_cliente', ''),
      ('licenca_cache_expira_em', ''),
      ('licenca_cache_machine_code', ''),
      ('licenca_cache_validada_em', ''),
      ('categorias_customizadas', '[]'),
      ('localizacoes_customizadas', '[]'),
      ('sequencia_codigo_almox_item', '1')
    ON CONFLICT (chave) DO NOTHING
  `);

  await migrarSenhasLegadasParaHash(db);

  const admin = await getDb(db, `SELECT * FROM usuarios WHERE usuario = $1`, ["admin"]);
  if (!admin) {
    const senhaAdminBootstrap = obterSenhaBootstrapAdmin();
    const hashAdminBootstrap = await bcrypt.hash(senhaAdminBootstrap, 10);
    await runDb(db, `INSERT INTO usuarios (usuario, senha, perfil) VALUES ($1, $2, $3)`, ["admin", hashAdminBootstrap, "admin"]);
    console.log("Usuario admin bootstrap criado. Altere a senha imediatamente apos o primeiro acesso.");
    const novoAdmin = await getDb(db, `SELECT id FROM usuarios WHERE usuario = $1`, ["admin"]);
    if (novoAdmin?.id) {
      await runDb(db, `
        INSERT INTO permissoes_usuarios (
          user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
          usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
        ) VALUES ($1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
        ON CONFLICT (user_id) DO NOTHING
      `, [novoAdmin.id]);
    }
  }
}

module.exports = {
  initDatabaseSchema
};
