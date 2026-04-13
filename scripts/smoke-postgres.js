require("dotenv").config();

const path = require("path");
const { spawn } = require("child_process");
const bcrypt = require("bcryptjs");
const { createDatabase } = require("../lib/database");
const { initDatabaseSchema } = require("../lib/schema");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PORT = 3700 + Math.floor(Math.random() * 200);
const PORT = Number(process.env.SMOKE_POSTGRES_PORT || process.env.PORT || DEFAULT_PORT);
const BASE_URL = String(process.env.SMOKE_POSTGRES_BASE_URL || `http://127.0.0.1:${PORT}`);
const SHOULD_SPAWN_SERVER = !["1", "true", "yes", "on"].includes(
  String(process.env.SMOKE_POSTGRES_SKIP_SPAWN || "").trim().toLowerCase()
);
const TEST_SUFFIX = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TEMP_ADMIN = `smoke_pg_admin_${TEST_SUFFIX}`;
const TEMP_ADMIN_PASSWORD = "SmokePg!123";
const TEMP_OPERATOR = `smoke_pg_oper_${TEST_SUFFIX}`;
const TEMP_OPERATOR_PASSWORD = "Operador!123";

function runDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ id: this?.lastID ?? null, changes: this?.changes ?? 0 });
    });
  });
}

function getCookiesFromResponse(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") && text ? JSON.parse(text) : text;

  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${text}`);
  }

  return { response, data, text };
}

async function requestBinary(url, options = {}) {
  const response = await fetch(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const text = buffer.toString("utf8");
    throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${text}`);
  }

  return { response, buffer };
}

async function waitForServer(serverProcess) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`Servidor encerrou antes do smoke test (exit code ${serverProcess.exitCode}).`);
    }

    try {
      const response = await fetch(`${BASE_URL}/api/status`);
      if (response.ok) {
        return;
      }
    } catch (_) {}

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Servidor não respondeu dentro do tempo limite do smoke test.");
}

async function createTempAdmin(db) {
  const hash = await bcrypt.hash(TEMP_ADMIN_PASSWORD, 10);

  await runDb(db, `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`, [
    TEMP_ADMIN,
    hash,
    "admin"
  ]);
}

async function cleanupArtifacts(db, state) {
  const auditPatterns = [TEMP_ADMIN, TEMP_OPERATOR, ...(state.itemCodes || []), ...(state.almoxCodes || [])]
    .filter(Boolean)
    .map((value) => `%${value}%`);

  await db.withTransaction(async () => {
    if (state.itemIds.length) {
      await runDb(
        db,
        `DELETE FROM movimentacoes WHERE item_id IN (${state.itemIds.map(() => "?").join(",")})`,
        state.itemIds
      );
      await runDb(
        db,
        `DELETE FROM itens WHERE id IN (${state.itemIds.map(() => "?").join(",")})`,
        state.itemIds
      );
    }

    if (state.almoxItemIds.length) {
      await runDb(
        db,
        `DELETE FROM almoxarifado_movimentacoes WHERE item_id IN (${state.almoxItemIds.map(() => "?").join(",")})`,
        state.almoxItemIds
      );
      await runDb(
        db,
        `DELETE FROM almoxarifado_itens WHERE id IN (${state.almoxItemIds.map(() => "?").join(",")})`,
        state.almoxItemIds
      );
    }

    if (auditPatterns.length) {
      const clauses = auditPatterns.map(() => "detalhes LIKE ?").join(" OR ");
      await runDb(
        db,
        `DELETE FROM auditoria_acoes WHERE usuario IN (?, ?) OR ${clauses}`,
        [TEMP_ADMIN, TEMP_OPERATOR, ...auditPatterns]
      );
    } else {
      await runDb(db, `DELETE FROM auditoria_acoes WHERE usuario IN (?, ?)`, [TEMP_ADMIN, TEMP_OPERATOR]);
    }

    await runDb(
      db,
      `DELETE FROM permissoes_usuarios WHERE user_id IN (SELECT id FROM usuarios WHERE usuario IN (?, ?))`,
      [TEMP_ADMIN, TEMP_OPERATOR]
    );
    await runDb(db, `DELETE FROM usuarios WHERE usuario IN (?, ?)`, [TEMP_ADMIN, TEMP_OPERATOR]);
  });
}

function logStep(message) {
  console.log(`[smoke-postgres] ${message}`);
}

async function main() {
  process.env.DB_CLIENT = "postgres";

  const db = createDatabase({ sqliteFile: path.join(ROOT_DIR, "db", "inventario.db") });
  const state = {
    itemIds: [],
    itemCodes: [],
    almoxItemIds: [],
    almoxCodes: []
  };
  let serverProcess = null;

  try {
    await initDatabaseSchema(db);
    await cleanupArtifacts(db, state);
    await createTempAdmin(db);

    if (SHOULD_SPAWN_SERVER) {
      serverProcess = spawn(process.execPath, ["server.js"], {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          DB_CLIENT: "postgres",
          PORT: String(PORT),
          UNIQSTOCK_FORCE_LOCAL_LICENSE: process.env.UNIQSTOCK_FORCE_LOCAL_LICENSE || "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      serverProcess.stdout.on("data", (chunk) => process.stdout.write(chunk));
      serverProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }

    await waitForServer(serverProcess);
    logStep("Servidor disponível.");

    const statusResult = await requestJson(`${BASE_URL}/api/status`);
    if (statusResult.data?.db_client !== "postgres") {
      throw new Error(`Esperava db_client=postgres, recebi ${JSON.stringify(statusResult.data)}`);
    }
    logStep("Status do app confirmado em postgres.");

    const loginResult = await requestJson(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usuario: TEMP_ADMIN,
        senha: TEMP_ADMIN_PASSWORD
      })
    });
    const sessionCookie = getCookiesFromResponse(loginResult.response)
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    if (!sessionCookie) {
      throw new Error("Login bem-sucedido, mas sem cookie de sessão.");
    }
    logStep("Login administrativo validado.");

    const authHeaders = { Cookie: sessionCookie };
    const meResult = await requestJson(`${BASE_URL}/api/me`, { headers: authHeaders });
    if (meResult.data?.user?.usuario !== TEMP_ADMIN) {
      throw new Error(`Usuário autenticado inesperado: ${JSON.stringify(meResult.data)}`);
    }

    const permsResult = await requestJson(`${BASE_URL}/api/minhas-permissoes`, { headers: authHeaders });
    if (permsResult.data?.perfil !== "admin") {
      throw new Error(`Perfil inesperado em /api/minhas-permissoes: ${JSON.stringify(permsResult.data)}`);
    }
    logStep("Sessão e permissões administrativas confirmadas.");

    await requestJson(`${BASE_URL}/api/usuarios`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        usuario: TEMP_OPERATOR,
        senha: TEMP_OPERATOR_PASSWORD,
        perfil: "operador"
      })
    });

    const usersResult = await requestJson(`${BASE_URL}/api/usuarios`, { headers: authHeaders });
    const tempOperator = (usersResult.data || []).find((user) => user.usuario === TEMP_OPERATOR);
    if (!tempOperator?.id) {
      throw new Error("Usuário operador temporário não foi encontrado após criação.");
    }

    await requestJson(`${BASE_URL}/api/usuarios/${tempOperator.id}/permissoes`, { headers: authHeaders });
    await requestJson(`${BASE_URL}/api/usuarios/${tempOperator.id}/permissoes`, {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        criar_itens: 1,
        editar_itens: 1,
        excluir_itens: 1,
        registrar_movimentacao: 1,
        importar_exportar: 1
      })
    });
    logStep("CRUD de usuários/permissões validado.");

    const createItemResult = await requestJson(`${BASE_URL}/api/itens`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ferramenta: `Furadeira Smoke ${TEST_SUFFIX}`,
        categoria: "Ferramenta elétrica",
        marca_modelo: "Smoke Model",
        quantidade_total: 3,
        localizacao: "Ferramentaria",
        estado_inicial: "Bom",
        observacao: `Teste postgres ${TEST_SUFFIX}`
      })
    });

    const itemCode = createItemResult.data?.codigo;
    const itemsResult = await requestJson(`${BASE_URL}/api/itens`, { headers: authHeaders });
    const item = (itemsResult.data || []).find((row) => row.codigo === itemCode);
    if (!item?.id) {
      throw new Error(`Item recém-criado não encontrado no inventário: ${itemCode}`);
    }
    state.itemIds.push(Number(item.id));
    state.itemCodes.push(itemCode);

    await requestJson(`${BASE_URL}/api/itens/${item.id}`, {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        codigo: itemCode,
        ferramenta: `Furadeira Smoke ${TEST_SUFFIX} Editada`,
        categoria: "Ferramenta elétrica",
        marca_modelo: "Smoke Model X",
        quantidade_total: 4,
        localizacao: "Sala PRZ",
        estado_inicial: "Ótimo",
        observacao: `Atualizado ${TEST_SUFFIX}`
      })
    });

    await requestJson(`${BASE_URL}/api/movimentacoes`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        item_id: item.id,
        tipo: "ENTRADA",
        quantidade: 2,
        obra: "Obra Smoke",
        funcionario: "Funcionario Smoke",
        observacao: "Entrada de teste"
      })
    });

    const movementsResult = await requestJson(`${BASE_URL}/api/movimentacoes`, { headers: authHeaders });
    const movement = (movementsResult.data || []).find((row) => row.codigo === itemCode);
    if (!movement) {
      throw new Error(`Movimentação não encontrada para o item ${itemCode}`);
    }

    await requestJson(`${BASE_URL}/api/qrcode/${item.id}`, { headers: authHeaders });
    const itemQrResult = await requestJson(`${BASE_URL}/api/item-qr/UNIQ-${itemCode}`, { headers: authHeaders });
    if (itemQrResult.data?.codigo !== itemCode) {
      throw new Error(`Scanner retornou item inesperado: ${JSON.stringify(itemQrResult.data)}`);
    }

    const deleteResponse = await fetch(`${BASE_URL}/api/itens/${item.id}`, {
      method: "DELETE",
      headers: authHeaders
    });
    const deletePayload = await deleteResponse.json();
    if (deleteResponse.status !== 400 || !String(deletePayload?.error || "").includes("histórico")) {
      throw new Error(`Bloqueio de exclusão com histórico falhou: ${JSON.stringify(deletePayload)}`);
    }
    logStep("Fluxo principal de inventário validado.");

    const createAlmoxResult = await requestJson(`${BASE_URL}/api/almoxarifado/itens`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ferramenta: `Parafuso Smoke ${TEST_SUFFIX}`,
        categoria: "Consumível",
        marca_modelo: "Lote Smoke",
        quantidade_total: 10,
        unidade_medida: "un",
        embalagem: "Caixa",
        estoque_minimo: 2,
        fornecedor: "Fornecedor Smoke",
        localizacao: "Almoxarifado",
        estado_inicial: "Novo",
        observacao: "Teste almox"
      })
    });

    const almoxCode = createAlmoxResult.data?.codigo;
    const almoxItemsResult = await requestJson(`${BASE_URL}/api/almoxarifado/itens`, { headers: authHeaders });
    const almoxItem = (almoxItemsResult.data || []).find((row) => row.codigo === almoxCode);
    if (!almoxItem?.id) {
      throw new Error(`Item do almoxarifado não encontrado: ${almoxCode}`);
    }
    state.almoxItemIds.push(Number(almoxItem.id));
    state.almoxCodes.push(almoxCode);

    await requestJson(`${BASE_URL}/api/almoxarifado/movimentacoes`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        item_id: almoxItem.id,
        tipo: "SAIDA",
        quantidade: 1,
        obra: "Obra Smoke",
        funcionario: "Funcionario Smoke",
        observacao: "Saída de teste"
      })
    });

    const almoxMovementsResult = await requestJson(`${BASE_URL}/api/almoxarifado/movimentacoes`, {
      headers: authHeaders
    });
    const almoxMovement = (almoxMovementsResult.data || []).find((row) => row.codigo === almoxCode);
    if (!almoxMovement) {
      throw new Error(`Movimentação de almoxarifado não encontrada para ${almoxCode}`);
    }
    logStep("Fluxo de almoxarifado validado.");

    const auditResult = await requestJson(`${BASE_URL}/api/auditoria?usuario=${TEMP_ADMIN}&limit=20`, {
      headers: authHeaders
    });
    if (!Array.isArray(auditResult.data) || auditResult.data.length === 0) {
      throw new Error("Auditoria vazia para o usuário de smoke test.");
    }

    const auditCsvResult = await requestBinary(`${BASE_URL}/api/auditoria/exportar-csv?usuario=${TEMP_ADMIN}`, {
      headers: authHeaders
    });
    if (!String(auditCsvResult.response.headers.get("content-type") || "").includes("text/csv")) {
      throw new Error("Exportação CSV de auditoria não retornou text/csv.");
    }

    const inventoryPdf = await requestBinary(`${BASE_URL}/api/exportar-inventario?ids=${item.id}`, {
      headers: authHeaders
    });
    if (!String(inventoryPdf.response.headers.get("content-type") || "").includes("application/pdf")) {
      throw new Error("Exportação de inventário não retornou PDF.");
    }

    const almoxPdf = await requestBinary(`${BASE_URL}/api/exportar-almoxarifado`, {
      headers: authHeaders
    });
    if (!String(almoxPdf.response.headers.get("content-type") || "").includes("application/pdf")) {
      throw new Error("Exportação de almoxarifado não retornou PDF.");
    }
    logStep("Auditoria e exportações validadas.");

    console.log("[smoke-postgres] OK");
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => {
        serverProcess.once("exit", () => resolve());
        setTimeout(resolve, 5000);
      });
    }

    await cleanupArtifacts(db, state).catch((error) => {
      console.error("[smoke-postgres] Falha na limpeza:", error.message);
    });
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(`[smoke-postgres] FAIL: ${error.message}`);
  process.exitCode = 1;
});
