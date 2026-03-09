const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const csv = require("csv-parser");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const xlsx = require("xlsx");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const packageJson = require("./package.json");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// =========================
// PASTAS NECESSÁRIAS
// =========================
const RUNTIME_BASE_DIR = process.env.UNIQSTOCK_RUNTIME_DIR
  ? path.resolve(process.env.UNIQSTOCK_RUNTIME_DIR)
  : __dirname;
const DB_DIR = path.join(RUNTIME_BASE_DIR, "db");
const UPLOAD_DIR = path.join(RUNTIME_BASE_DIR, "uploads");
const BACKUP_DIR = path.join(RUNTIME_BASE_DIR, "backups");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DB_DIR, "inventario.db"));
const upload = multer({ dest: UPLOAD_DIR });
const LICENSE_SECRET = process.env.UNIQSTOCK_LICENSE_SECRET || "uniqstock-license-secret-change";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE_LICENSE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = USE_SUPABASE_LICENSE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false
  })
);

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const raw = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  return Buffer.from(raw + padding, "base64").toString("utf8");
}

function normalizarDataIso(dataTexto) {
  const texto = String(dataTexto || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T00:00:00`);
  if (Number.isNaN(data.getTime())) return null;
  return texto;
}

function calcularDiasRestantes(dataIso) {
  const base = normalizarDataIso(dataIso);
  if (!base) return -1;
  const agora = new Date();
  const fim = new Date(`${base}T23:59:59`);
  return Math.floor((fim.getTime() - agora.getTime()) / (24 * 60 * 60 * 1000));
}

function assinarLicenca(payloadB64) {
  return toBase64Url(
    crypto.createHmac("sha256", LICENSE_SECRET).update(payloadB64).digest()
  );
}

function gerarCodigoMaquina() {
  const bruto = [
    os.hostname() || "",
    os.platform() || "",
    os.arch() || "",
    process.env.COMPUTERNAME || ""
  ].join("|");

  const hash = crypto.createHash("sha256").update(bruto).digest("hex");
  return `MCH-${hash.slice(0, 16).toUpperCase()}`;
}

function gerarChaveLicenca(cliente, expiraEm, codigoMaquina = "") {
  const clienteLimpo = String(cliente || "").trim();
  const dataIso = normalizarDataIso(expiraEm);
  if (!clienteLimpo || !dataIso) {
    throw new Error("Cliente e data de expiração válidos são obrigatórios");
  }
  const payload = {
    v: 1,
    cliente: clienteLimpo,
    exp: dataIso,
    iat: new Date().toISOString(),
    mch: String(codigoMaquina || "").trim().toUpperCase() || undefined
  };
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const assinatura = assinarLicenca(payloadB64);
  return `USK1.${payloadB64}.${assinatura}`;
}

function validarChaveLicenca(chave, codigoMaquinaLocal = "") {
  const texto = String(chave || "").trim();
  const partes = texto.split(".");
  if (partes.length !== 3 || partes[0] !== "USK1") {
    return { ok: false, motivo: "Formato de chave inválido" };
  }

  const payloadB64 = partes[1];
  const assinatura = partes[2];
  const esperado = assinarLicenca(payloadB64);
  const assinaturaBuf = Buffer.from(assinatura);
  const esperadoBuf = Buffer.from(esperado);

  if (assinaturaBuf.length !== esperadoBuf.length ||
      !crypto.timingSafeEqual(assinaturaBuf, esperadoBuf)) {
    return { ok: false, motivo: "Assinatura inválida" };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64));
  } catch (_) {
    return { ok: false, motivo: "Payload da chave inválido" };
  }

  const dataIso = normalizarDataIso(payload?.exp);
  const cliente = String(payload?.cliente || "").trim();
  const codigoMaquinaChave = String(payload?.mch || "").trim().toUpperCase();
  const codigoMaquina = String(codigoMaquinaLocal || "").trim().toUpperCase();
  if (!cliente || !dataIso) {
    return { ok: false, motivo: "Dados da chave incompletos" };
  }
  if (codigoMaquinaChave && codigoMaquinaChave !== codigoMaquina) {
    return { ok: false, motivo: "Licença vinculada a outra máquina" };
  }
  if (calcularDiasRestantes(dataIso) < 0) {
    return { ok: false, motivo: "Licença expirada" };
  }

  return { ok: true, payload: { cliente, exp: dataIso, mch: codigoMaquinaChave || null } };
}

async function obterStatusLicencaLocal() {
  try {
    const codigoMaquina = gerarCodigoMaquina();
    const ativa = (await obterConfigValor("licenca_ativa", "0")) === "1";
    const chave = await obterConfigValor("licenca_chave", "");
    if (!ativa || !chave) {
      return {
        ativa: false,
        motivo: "Licença não ativada",
        codigo_maquina: codigoMaquina,
        provedor: "local"
      };
    }

    const validacao = validarChaveLicenca(chave, codigoMaquina);
    if (!validacao.ok) {
      return {
        ativa: false,
        motivo: validacao.motivo,
        codigo_maquina: codigoMaquina,
        provedor: "local"
      };
    }

    const diasRestantes = calcularDiasRestantes(validacao.payload.exp);
    return {
      ativa: true,
      cliente: validacao.payload.cliente,
      expira_em: validacao.payload.exp,
      dias_restantes: diasRestantes,
      codigo_maquina: codigoMaquina,
      provedor: "local"
    };
  } catch (e) {
    return {
      ativa: false,
      motivo: "Não foi possível validar a licença",
      codigo_maquina: gerarCodigoMaquina(),
      provedor: "local"
    };
  }
}

async function obterStatusLicencaSupabase() {
  const codigoMaquina = gerarCodigoMaquina();
  const chave = await obterConfigValor("licenca_chave", "");
  if (!chave) {
    return {
      ativa: false,
      motivo: "Licença não ativada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const { data, error } = await supabase
    .from("licenses")
    .select("license_key, client_name, machine_code, expires_at, status, activated_at")
    .eq("license_key", chave)
    .maybeSingle();

  if (error) {
    return {
      ativa: false,
      motivo: "Servidor de licenças indisponível",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  if (!data) {
    return {
      ativa: false,
      motivo: "Chave não encontrada no servidor de licenças",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const status = String(data.status || "").toLowerCase();
  if (status === "revoked" || status === "suspended") {
    return {
      ativa: false,
      motivo: "Licença revogada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const expIso = normalizarDataIso(String(data.expires_at || "").slice(0, 10));
  if (!expIso || calcularDiasRestantes(expIso) < 0) {
    return {
      ativa: false,
      motivo: "Licença expirada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const machineCodeDb = String(data.machine_code || "").trim().toUpperCase();
  if (!machineCodeDb) {
    return {
      ativa: false,
      motivo: "Licença ainda não ativada neste dispositivo",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  if (machineCodeDb !== codigoMaquina) {
    return {
      ativa: false,
      motivo: "Licença vinculada a outra máquina",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const diasRestantes = calcularDiasRestantes(expIso);
  return {
    ativa: true,
    cliente: String(data.client_name || "Cliente"),
    expira_em: expIso,
    dias_restantes: diasRestantes,
    codigo_maquina: codigoMaquina,
    provedor: "supabase"
  };
}

async function ativarLicencaLocal(chave) {
  const validacao = validarChaveLicenca(chave, gerarCodigoMaquina());
  if (!validacao.ok) {
    return { ok: false, error: validacao.motivo, status: 400 };
  }

  await definirConfigValor("licenca_ativa", "1");
  await definirConfigValor("licenca_chave", chave);
  await definirConfigValor("licenca_cliente", validacao.payload.cliente);
  await definirConfigValor("licenca_expira_em", validacao.payload.exp);
  await definirConfigValor("licenca_ativada_em", new Date().toISOString());

  return {
    ok: true,
    cliente: validacao.payload.cliente,
    expira_em: validacao.payload.exp
  };
}

async function ativarLicencaSupabase(chave) {
  const codigoMaquina = gerarCodigoMaquina();
  const { data, error } = await supabase
    .from("licenses")
    .select("license_key, client_name, machine_code, expires_at, status, activated_at")
    .eq("license_key", chave)
    .maybeSingle();

  if (error) {
    return { ok: false, error: "Servidor de licenças indisponível", status: 503 };
  }

  if (!data) {
    return { ok: false, error: "Chave não encontrada", status: 400 };
  }

  const status = String(data.status || "").toLowerCase();
  if (status === "revoked" || status === "suspended") {
    return { ok: false, error: "Licença revogada", status: 400 };
  }

  const expIso = normalizarDataIso(String(data.expires_at || "").slice(0, 10));
  if (!expIso || calcularDiasRestantes(expIso) < 0) {
    return { ok: false, error: "Licença expirada", status: 400 };
  }

  const machineCodeDb = String(data.machine_code || "").trim().toUpperCase();
  if (machineCodeDb && machineCodeDb !== codigoMaquina) {
    return { ok: false, error: "Licença vinculada a outra máquina", status: 400 };
  }

  const payloadUpdate = {
    machine_code: machineCodeDb || codigoMaquina,
    status: "active",
    activated_at: data.activated_at || new Date().toISOString()
  };

  const { error: updateError } = await supabase
    .from("licenses")
    .update(payloadUpdate)
    .eq("license_key", chave);

  if (updateError) {
    return { ok: false, error: "Não foi possível ativar a licença", status: 500 };
  }

  await definirConfigValor("licenca_ativa", "1");
  await definirConfigValor("licenca_chave", chave);
  await definirConfigValor("licenca_cliente", String(data.client_name || "Cliente"));
  await definirConfigValor("licenca_expira_em", expIso);
  await definirConfigValor("licenca_ativada_em", new Date().toISOString());

  return {
    ok: true,
    cliente: String(data.client_name || "Cliente"),
    expira_em: expIso
  };
}

const cacheLicenca = {
  expiraEmMs: 0,
  valor: null
};

function invalidarCacheLicenca() {
  cacheLicenca.expiraEmMs = 0;
  cacheLicenca.valor = null;
}

async function obterStatusLicenca() {
  const agora = Date.now();
  if (cacheLicenca.valor && cacheLicenca.expiraEmMs > agora) {
    return cacheLicenca.valor;
  }

  const status = USE_SUPABASE_LICENSE
    ? await obterStatusLicencaSupabase()
    : await obterStatusLicencaLocal();

  cacheLicenca.valor = status;
  cacheLicenca.expiraEmMs = agora + 5000;
  return status;
}

function rotaLicencaLivre(req) {
  const caminho = req.path || "/";
  if (caminho === "/login.html" || caminho === "/ativacao.html" || caminho === "/") return true;
  if (caminho === "/api/status" || caminho === "/api/login" || caminho === "/api/logout") return true;
  if (caminho === "/api/licenca/status" || caminho === "/api/licenca/ativar" || caminho === "/api/licenca/maquina") return true;
  if (caminho.startsWith("/img/")) return true;
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|map)$/i.test(caminho)) return true;
  return false;
}

app.use(async (req, res, next) => {
  if (rotaLicencaLivre(req)) return next();
  const status = await obterStatusLicenca();
  if (status.ativa) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(403).json({
      error: "Licença não ativada",
      codigo: "LICENCA_NAO_ATIVA",
      motivo: status.motivo
    });
  }

  if (req.path.endsWith(".html")) {
    return res.redirect("/ativacao.html");
  }

  return next();
});

// Protege a página de permissões no servidor (acesso direto por URL)
app.get("/permissoes.html", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login.html");
  }
  if (req.session.user.perfil !== "admin") {
    return res.redirect("/acesso-negado.html");
  }
  return res.sendFile(path.join(__dirname, "public", "permissoes.html"));
});

app.get("/auditoria.html", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login.html");
  }
  if (req.session.user.perfil !== "admin") {
    return res.redirect("/acesso-negado.html");
  }
  return res.sendFile(path.join(__dirname, "public", "auditoria.html"));
});

app.get("/configuracoes.html", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect("/login.html");
  }
  if (req.session.user.perfil !== "admin") {
    return res.redirect("/acesso-negado.html");
  }
  return res.sendFile(path.join(__dirname, "public", "configuracoes.html"));
});

app.use(express.static(path.join(__dirname, "public"), { index: "login.html" }));

// =========================
// HELPERS
// =========================
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function normalizeText(value) {
  return value ? String(value).trim() : "";
}

function validarSenhaForte(senha) {
  const texto = String(senha || "");
  if (texto.length < 8) return "Senha deve ter ao menos 8 caracteres";
  if (!/[A-Z]/.test(texto)) return "Senha deve conter ao menos 1 letra maiúscula";
  if (!/[a-z]/.test(texto)) return "Senha deve conter ao menos 1 letra minúscula";
  if (!/[0-9]/.test(texto)) return "Senha deve conter ao menos 1 número";
  if (!/[^A-Za-z0-9]/.test(texto)) return "Senha deve conter ao menos 1 caractere especial";
  return null;
}

function parseNumero(value) {
  const texto = String(value ?? "").trim().replace(",", ".");
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function parseSemver(valor) {
  const texto = String(valor || "").trim();
  const match = texto.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || ""
  };
}

function compararPreRelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const va = pa[i] || "";
    const vb = pb[i] || "";
    if (va === vb) continue;
    const na = /^\d+$/.test(va) ? Number(va) : NaN;
    const nb = /^\d+$/.test(vb) ? Number(vb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return va.localeCompare(vb);
  }
  return 0;
}

function isVersaoMaisNova(latest, current) {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return latest !== current;

  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  if (l.patch !== c.patch) return l.patch > c.patch;
  return compararPreRelease(l.pre, c.pre) > 0;
}

async function criarConfiguracaoSeNaoExistir(chave, valor) {
  const existente = await getQuery(
    `SELECT chave FROM configuracoes WHERE chave = ?`,
    [chave]
  );

  if (!existente) {
    await runQuery(
      `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)`,
      [chave, String(valor)]
    );
  }
}

async function gerarCodigoAutomatico(codigoInformado) {
  const codigoManual = normalizeText(codigoInformado);

  if (codigoManual) {
    const existente = await getQuery(
      `SELECT id FROM itens WHERE codigo = ?`,
      [codigoManual]
    );

    if (existente) {
      throw new Error(`O código "${codigoManual}" já existe.`);
    }

    return codigoManual;
  }

  await criarConfiguracaoSeNaoExistir("sequencia_codigo_item", "1");

  const seq = await getQuery(
    `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_item'`
  );

  let numeroAtual = seq ? Number(seq.valor) : 1;
  if (!Number.isFinite(numeroAtual) || numeroAtual < 1) numeroAtual = 1;

  let codigoFinal = "";
  let encontrouLivre = false;

  while (!encontrouLivre) {
    codigoFinal = `FER-${String(numeroAtual).padStart(4, "0")}`;

    const existente = await getQuery(
      `SELECT id FROM itens WHERE codigo = ?`,
      [codigoFinal]
    );

    if (!existente) {
      encontrouLivre = true;
    } else {
      numeroAtual++;
    }
  }

  await runQuery(
    `UPDATE configuracoes
     SET valor = ?
     WHERE chave = 'sequencia_codigo_item'`,
    [numeroAtual + 1]
  );

  return codigoFinal;
}

async function obterEstoqueAtual(itemId) {
  const item = await getQuery(
    `
    SELECT
      i.id,
      COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.quantidade ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN m.tipo = 'SAIDA' THEN m.quantidade ELSE 0 END), 0) AS estoque_atual
    FROM itens i
    LEFT JOIN movimentacoes m ON m.item_id = i.id
    WHERE i.id = ?
    GROUP BY i.id
    `,
    [itemId]
  );

  return item ? Number(item.estoque_atual) : 0;
}

function deletarArquivoSeExistir(caminho) {
  try {
    if (caminho && fs.existsSync(caminho)) {
      fs.unlinkSync(caminho);
    }
  } catch (e) {
    console.error("Erro ao remover arquivo temporário:", e.message);
  }
}

function fazerBackupBanco() {
  const data = new Date().toISOString().replace(/[:.]/g, "-");
  const origem = path.join(DB_DIR, "inventario.db");
  const destino = path.join(BACKUP_DIR, `inventario-backup-${data}.db`);

  fs.copyFile(origem, destino, (err) => {
    if (err) {
      console.error("Erro ao criar backup:", err.message);
    } else {
      console.log("Backup criado:", destino);
    }
  });
}

async function obterConfigValor(chave, padrao = "") {
  const row = await getQuery(`SELECT valor FROM configuracoes WHERE chave = ?`, [chave]);
  return row?.valor !== undefined ? String(row.valor) : String(padrao);
}

async function definirConfigValor(chave, valor) {
  await runQuery(
    `INSERT INTO configuracoes (chave, valor)
     VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    [chave, String(valor)]
  );
}

async function listarArquivosBackup() {
  const nomes = await fs.promises.readdir(BACKUP_DIR);
  return nomes
    .filter((nome) => /^inventario-backup-.*\.db$/i.test(nome))
    .map((nome) => path.join(BACKUP_DIR, nome));
}

async function limparBackupsAntigos(reterDias) {
  const dias = Math.max(1, Number(reterDias) || 15);
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const arquivos = await listarArquivosBackup();

  for (const arquivo of arquivos) {
    try {
      const stat = await fs.promises.stat(arquivo);
      if (stat.mtimeMs < limite) {
        await fs.promises.unlink(arquivo);
      }
    } catch (_) {}
  }
}

async function executarBackupAutomatico() {
  fazerBackupBanco();
  const reterDias = await obterConfigValor("backup_reter_dias", "15");
  await limparBackupsAntigos(reterDias);
}

function normalizarCabecalho(chaveOriginal) {
  const chave = normalizeText(chaveOriginal)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const mapa = {
    codigo: "codigo",
    cod: "codigo",
    cod_item: "codigo",
    codigo_item: "codigo",
    codigo_produto: "codigo",

    ferramenta: "ferramenta",
    nome: "ferramenta",
    item: "ferramenta",
    descricao: "ferramenta",
    descricao_item: "ferramenta",
    descricao_produto: "ferramenta",
    produto: "ferramenta",

    categoria: "categoria",
    grupo: "categoria",
    tipo: "categoria",

    marca_modelo: "marca_modelo",
    marca: "marca_modelo",
    modelo: "marca_modelo",
    marca_modelo_item: "marca_modelo",
    marca_modelo_produto: "marca_modelo",
    fabricante: "marca_modelo",

    quantidade_total: "quantidade_total",
    quantidade: "quantidade_total",
    qtd: "quantidade_total",
    qtde: "quantidade_total",
    qtd_total: "quantidade_total",
    qtde_total: "quantidade_total",
    estoque: "quantidade_total",
    estoque_inicial: "quantidade_total",
    saldo: "quantidade_total",

    localizacao: "localizacao",
    local: "localizacao",
    endereco: "localizacao",
    setor: "localizacao",
    deposito: "localizacao",

    estado_inicial: "estado_inicial",
    estado: "estado_inicial",
    condicao: "estado_inicial",
    situacao: "estado_inicial",

    observacao: "observacao",
    observacoes: "observacao",
    obs: "observacao",
    detalhe: "observacao",
    detalhes: "observacao"
  };

  if (mapa[chave]) return mapa[chave];

  // Fallbacks por prefixo para planilhas com sufixos variados.
  if (chave.startsWith("cod")) return "codigo";
  if (chave.startsWith("qtd") || chave.startsWith("qtde") || chave.startsWith("quant")) return "quantidade_total";
  if (chave.startsWith("obs")) return "observacao";

  return chave;
}

function normalizarLinhaImportacao(linha) {
  const linhaNormalizada = {};

  for (const [chave, valor] of Object.entries(linha || {})) {
    const chaveNormalizada = normalizarCabecalho(chave);
    linhaNormalizada[chaveNormalizada] = typeof valor === "string" ? valueOrEmpty(valor) : valueOrEmpty(valor);
  }

  return linhaNormalizada;
}

function valueOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function decodeXmlEntities(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeXmlTagName(tagName) {
  return String(tagName || "").split(":").pop().trim().toLowerCase();
}

function parseXmlRegistroFields(xmlTrecho) {
  const resultado = {};
  const regexCampo = /<([a-zA-Z_][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;

  while ((match = regexCampo.exec(xmlTrecho)) !== null) {
    const tag = normalizeXmlTagName(match[1]);
    const valorBruto = String(match[2] ?? "");

    // Evita nós complexos aninhados para manter parser simples e previsível.
    if (/<[a-zA-Z_][\w:.-]*\b[^>]*>/.test(valorBruto)) continue;

    resultado[tag] = decodeXmlEntities(valorBruto).trim();
  }

  return resultado;
}

function parseXmlParaLinhas(xmlBruto) {
  const xml = String(xmlBruto ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  if (!xml) return [];

  const nomesRegistro = ["item", "registro", "linha", "row", "ferramenta"];
  let linhas = [];

  for (const nome of nomesRegistro) {
    const regexRegistro = new RegExp(`<${nome}\\b[^>]*>([\\s\\S]*?)<\\/${nome}>`, "gi");
    let match;
    const coletadas = [];

    while ((match = regexRegistro.exec(xml)) !== null) {
      const campos = parseXmlRegistroFields(match[1]);
      if (Object.keys(campos).length > 0) {
        coletadas.push(campos);
      }
    }

    if (coletadas.length > 0) {
      linhas = coletadas;
      break;
    }
  }

  // Fallback: tenta interpretar o XML inteiro como um unico registro simples.
  if (linhas.length === 0) {
    const unico = parseXmlRegistroFields(xml);
    if (Object.keys(unico).length > 0) {
      linhas = [unico];
    }
  }

  return linhas;
}

function linhaTemConteudo(linha) {
  const campos = [
    linha.codigo,
    linha.ferramenta,
    linha.categoria,
    linha.marca_modelo,
    linha.quantidade_total,
    linha.localizacao,
    linha.estado_inicial,
    linha.observacao
  ];

  return campos.some((campo) => normalizeText(campo) !== "");
}

async function importarLinhasNoBanco(linhas) {
  const relatorio = {
    total_recebido: Array.isArray(linhas) ? linhas.length : 0,
    total_importado: 0,
    total_ignorado: 0,
    total_erros: 0,
    ignorados: [],
    erros: []
  };

  for (let i = 0; i < (linhas || []).length; i++) {
    const linhaBruta = linhas[i];
    const numeroLinha = i + 2; // considera cabecalho na primeira linha para CSV/XLS(X)
    const linha = normalizarLinhaImportacao(linhaBruta);

    if (!linhaTemConteudo(linha)) {
      relatorio.total_ignorado++;
      relatorio.ignorados.push({
        linha: numeroLinha,
        motivo: "Linha vazia"
      });
      continue;
    }

    const nomeFerramenta = normalizeText(linha.ferramenta);

    if (!nomeFerramenta) {
      relatorio.total_ignorado++;
      relatorio.ignorados.push({
        linha: numeroLinha,
        motivo: "Campo ferramenta/nome ausente"
      });
      continue;
    }

    try {
      const codigoFinal = await gerarCodigoAutomatico(linha.codigo);

      await runQuery(
        `INSERT INTO itens (
          codigo,
          ferramenta,
          categoria,
          marca_modelo,
          quantidade_total,
          localizacao,
          estado_inicial,
          observacao
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoFinal,
          nomeFerramenta,
          normalizeText(linha.categoria),
          normalizeText(linha.marca_modelo),
          parseNumero(linha.quantidade_total),
          normalizeText(linha.localizacao),
          normalizeText(linha.estado_inicial),
          normalizeText(linha.observacao)
        ]
      );

      relatorio.total_importado++;
    } catch (erro) {
      relatorio.total_erros++;
      relatorio.erros.push({
        linha: numeroLinha,
        codigo: normalizeText(linha.codigo),
        mensagem: String(erro?.message || "Erro ao importar linha")
      });
    }
  }

  return relatorio;
}

// =========================
// CRIAÇÃO DAS TABELAS
// =========================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      perfil TEXT
    )
  `);

  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS obras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      responsavel TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      matricula TEXT,
      funcao TEXT
    )
  `);

  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS permissoes_usuarios (
      user_id INTEGER PRIMARY KEY,
      ver_dashboard INTEGER DEFAULT 1,
      ver_inventario INTEGER DEFAULT 1,
      criar_editar_itens INTEGER DEFAULT 0,
      ver_etiquetas INTEGER DEFAULT 1,
      usar_scanner INTEGER DEFAULT 1,
      ver_movimentacoes INTEGER DEFAULT 1,
      registrar_movimentacao INTEGER DEFAULT 0,
      importar_exportar INTEGER DEFAULT 0,
      gerenciar_usuarios INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES usuarios(id)
    )
  `);

  db.run(`
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

  // Migração: preenche entidade_id de logs antigos de login usando o id do usuário.
  db.run(
    `
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
    `,
    [],
    function (err) {
      if (err) {
        console.error("Erro na migração de auditoria de login:", err.message);
        return;
      }
      if (this?.changes > 0) {
        console.log(`Migração auditoria login: ${this.changes} registro(s) atualizados.`);
      }
    }
  );

  db.get(
    `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_item'`,
    (err, row) => {
      if (err) {
        console.error("Erro ao verificar sequência de código:", err.message);
        return;
      }

      if (!row) {
        db.run(
          `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)`,
          ["sequencia_codigo_item", "1"]
        );
      }
    }
  );

  db.run(
    `INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES
      ('backup_auto_habilitado', '1'),
      ('backup_auto_horario', '02:00'),
      ('backup_reter_dias', '15'),
      ('licenca_ativa', '0'),
      ('licenca_chave', ''),
      ('licenca_cliente', ''),
      ('licenca_expira_em', ''),
      ('licenca_ativada_em', '')`
  );

  db.get(
    `SELECT * FROM usuarios WHERE usuario = ?`,
    ["admin"],
    (err, row) => {
      if (err) {
        console.error("Erro ao verificar usuário admin:", err.message);
        return;
      }

      if (!row) {
        db.run(
          `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`,
          ["admin", "admin123", "admin"],
          (insertErr) => {
            if (insertErr) {
              console.error("Erro ao criar usuário admin:", insertErr.message);
              return;
            }
            console.log("Usuário admin criado: admin / admin123");
            db.get(`SELECT id FROM usuarios WHERE usuario = ?`, ["admin"], (e2, r2) => {
              if (e2 || !r2) return;
              db.run(
                `INSERT OR IGNORE INTO permissoes_usuarios (
                  user_id, ver_dashboard, ver_inventario, criar_editar_itens, ver_etiquetas,
                  usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
                ) VALUES (?, 1, 1, 1, 1, 1, 1, 1, 1, 1)`,
                [r2.id]
              );
            });
          }
        );
      }
    }
  );
});

// =========================
// API: STATUS
// =========================
app.get("/api/status", (req, res) => {
  res.json({ ok: true, mensagem: "Servidor funcionando" });
});

app.get("/api/app/version", (req, res) => {
  res.json({ ok: true, version: packageJson.version || "0.0.0" });
});

async function obterReleaseAtualizacao(version = "") {
  if (!USE_SUPABASE_LICENSE || !supabase) {
    return { ok: false, status: 503, error: "Atualização remota indisponível (Supabase não configurado)" };
  }

  let query = supabase
    .from("app_releases")
    .select("version, url_installer, sha256, mandatory, notes, published_at, active")
    .eq("active", true);

  const versao = normalizeText(version);
  if (versao) {
    query = query.eq("version", versao);
  } else {
    query = query.order("published_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: "Falha ao consultar releases", detalhe: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Nenhuma release ativa encontrada" };
  }

  return { ok: true, release: data };
}

app.get("/api/app/update-check", async (req, res) => {
  try {
    const current = normalizeText(req.query.current || "");
    if (!current) {
      return res.status(400).json({ error: "Informe a versão atual em ?current=" });
    }

    const releaseResult = await obterReleaseAtualizacao();
    if (!releaseResult.ok) {
      if (releaseResult.status === 404) {
        return res.json({
          ok: true,
          current_version: current,
          update_available: false,
          latest: null
        });
      }
      return res.status(releaseResult.status || 500).json({
        error: releaseResult.error || "Erro ao consultar atualização",
        detalhe: releaseResult.detalhe
      });
    }

    const data = releaseResult.release;
    if (!data) {
      return res.json({
        ok: true,
        current_version: current,
        update_available: false,
        latest: null
      });
    }

    const latestVersion = String(data.version || "").trim();
    const updateAvailable = isVersaoMaisNova(latestVersion, current);

    return res.json({
      ok: true,
      current_version: current,
      update_available: updateAvailable,
      latest: {
        version: latestVersion,
        url_installer: data.url_installer,
        sha256: data.sha256 || null,
        mandatory: Boolean(data.mandatory),
        notes: data.notes || "",
        published_at: data.published_at || null
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/app/update-download", requireAuth, async (req, res) => {
  try {
    const versao = normalizeText(req.query.version || "");
    const releaseResult = await obterReleaseAtualizacao(versao);
    if (!releaseResult.ok) {
      return res.status(releaseResult.status || 500).json({
        error: releaseResult.error || "Erro ao obter release",
        detalhe: releaseResult.detalhe
      });
    }

    const release = releaseResult.release;
    const url = normalizeText(release.url_installer);
    if (!url) {
      return res.status(400).json({ error: "Release sem URL de instalador" });
    }

    return res.redirect(url);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/licenca/status", async (req, res) => {
  const status = await obterStatusLicenca();
  res.json({ ok: true, modo_remoto: USE_SUPABASE_LICENSE, ...status });
});

app.get("/api/licenca/maquina", async (req, res) => {
  res.json({ ok: true, codigo_maquina: gerarCodigoMaquina() });
});

app.post("/api/licenca/ativar", async (req, res) => {
  try {
    const chave = normalizeText(req.body?.chave);
    if (!chave) {
      return res.status(400).json({ error: "Informe a chave de ativação" });
    }

    const resultado = USE_SUPABASE_LICENSE
      ? await ativarLicencaSupabase(chave)
      : await ativarLicencaLocal(chave);

    if (!resultado.ok) {
      return res.status(resultado.status || 400).json({ error: resultado.error });
    }

    invalidarCacheLicenca();
    return res.json({ ok: true, cliente: resultado.cliente, expira_em: resultado.expira_em });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =========================
// API: CADASTRO (ADMIN)
// =========================
app.post("/api/cadastro", requireAdmin, async (req, res) => {
  try {
    const usuario = normalizeText(req.body.usuario);
    const senha = normalizeText(req.body.senha);

    if (!usuario || !senha) {
      return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
    }

    if (usuario.length < 3) {
      return res.status(400).json({ error: "Usuário deve ter ao menos 3 caracteres" });
    }

    const erroSenha = validarSenhaForte(senha);
    if (erroSenha) {
      return res.status(400).json({ error: erroSenha });
    }

    const existente = await getQuery(`SELECT id FROM usuarios WHERE usuario = ?`, [usuario]);
    if (existente) {
      return res.status(400).json({ error: "Usuário já existe" });
    }

    const hash = await bcrypt.hash(senha, 10);
    const result = await runQuery(
      `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`,
      [usuario, hash, "operador"]
    );

    await runQuery(
      `INSERT OR IGNORE INTO permissoes_usuarios (
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, 1, 1, 0, 1, 1, 1, 0, 0, 0)`,
      [result.id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// API: LOGIN
// =========================
app.post("/api/login", async (req, res) => {
  const statusLicenca = await obterStatusLicenca();
  if (!statusLicenca.ativa) {
    return res.status(403).json({
      error: "Licença não ativada. Ative o sistema para continuar.",
      codigo: "LICENCA_NAO_ATIVA",
      motivo: statusLicenca.motivo
    });
  }

  const usuario = normalizeText(req.body.usuario);
  const senha = normalizeText(req.body.senha);

  if (!usuario || !senha) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  }

  try {
    const user = await getQuery(
      `SELECT * FROM usuarios WHERE usuario = ?`,
      [usuario]
    );

    if (!user) {
      await registrarAuditoria(req, "LOGIN_FALHA", "auth", null, {
        usuario_tentativa: usuario,
        motivo: "usuario_nao_encontrado",
        ip: req.ip
      }, usuario || "desconhecido");
      return res.status(401).json({ error: "Usuário não encontrado" });
    }

    const isHash = typeof user.senha === "string" && user.senha.startsWith("$2");
    const senhaOk = isHash ? await bcrypt.compare(senha, user.senha) : user.senha === senha;

    if (!senhaOk) {
      await registrarAuditoria(req, "LOGIN_FALHA", "auth", null, {
        usuario_tentativa: usuario,
        motivo: "senha_incorreta",
        ip: req.ip
      }, usuario || "desconhecido");
      return res.status(401).json({ error: "Senha incorreta" });
    }

    req.session.user = { usuario: user.usuario, perfil: user.perfil };
    await registrarAuditoria(req, "LOGIN_SUCESSO", "auth", user.id, {
      usuario: user.usuario,
      perfil: user.perfil,
      ip: req.ip
    }, user.usuario);

    res.json({
      ok: true,
      usuario: user.usuario,
      perfil: user.perfil
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sessão: usuário atual
app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  res.json({ ok: true, user: req.session.user });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session?.destroy(() => {
    res.json({ ok: true });
  });
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  if (req.session.user.perfil !== "admin") {
    return res.status(403).json({ error: "Acesso negado" });
  }
  next();
}

async function getUserPerms(usuario) {
  const user = await getQuery(`SELECT id, perfil FROM usuarios WHERE usuario = ?`, [usuario]);
  if (!user) return null;
  const perms = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [user.id]);
  if (perms) return { user, perms };
  // criar padrão conforme perfil
  const isAdmin = user.perfil === "admin";
  await runQuery(
    `INSERT OR IGNORE INTO permissoes_usuarios (
      user_id, ver_dashboard, ver_inventario, criar_editar_itens, ver_etiquetas,
      usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      1, 1, isAdmin ? 1 : 0, 1,
      1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0
    ]
  );
  const created = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [user.id]);
  return { user, perms: created };
}

app.get("/api/minhas-permissoes", requireAuth, async (req, res) => {
  try {
    const info = await getUserPerms(req.session.user.usuario);
    if (!info) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json({
      ok: true,
      perfil: info.user.perfil,
      permissoes: info.perms
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function requirePerm(permissao) {
  return async function (req, res, next) {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    try {
      const info = await getUserPerms(req.session.user.usuario);
      if (!info) return res.status(401).json({ error: "Não autenticado" });
      if (info.user.perfil === "admin") return next();
      if (info.perms && info.perms[permissao] === 1) return next();
      return res.status(403).json({ error: "Permissão negada" });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };
}

async function registrarAuditoria(req, acao, entidade, entidadeId = null, detalhes = null, usuarioOverride = null) {
  try {
    const usuario = usuarioOverride || req?.session?.user?.usuario || "sistema";
    const detalhesTexto = detalhes ? JSON.stringify(detalhes) : null;
    await runQuery(
      `INSERT INTO auditoria_acoes (usuario, acao, entidade, entidade_id, detalhes)
       VALUES (?, ?, ?, ?, ?)`,
      [usuario, acao, entidade, entidadeId, detalhesTexto]
    );
  } catch (e) {
    console.error("Falha ao registrar auditoria:", e.message);
  }
}

// Alterar senha (usuário logado)
app.post("/api/alterar-senha", requireAuth, async (req, res) => {
  try {
    const usuarioSessao = req.session.user.usuario;
    const { senha_atual, senha_nova } = req.body || {};
    const atual = normalizeText(senha_atual);
    const nova = normalizeText(senha_nova);
    if (!atual || !nova) {
      return res.status(400).json({ error: "Informe senha atual e nova" });
    }
    const user = await getQuery(`SELECT * FROM usuarios WHERE usuario = ?`, [usuarioSessao]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const isHash = typeof user.senha === "string" && user.senha.startsWith("$2");
    const senhaOk = isHash ? await bcrypt.compare(atual, user.senha) : user.senha === atual;
    if (!senhaOk) return res.status(401).json({ error: "Senha atual incorreta" });
    const erroSenha = validarSenhaForte(nova);
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    const hash = await bcrypt.hash(nova, 10);
    await runQuery(`UPDATE usuarios SET senha = ? WHERE usuario = ?`, [hash, usuarioSessao]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resetar senha (admin escolhe usuário)
app.post("/api/usuarios/:id/reset-senha", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { senha_nova } = req.body || {};
    const nova = normalizeText(senha_nova);
    if (!nova) return res.status(400).json({ error: "Informe a nova senha" });
    const erroSenha = validarSenhaForte(nova);
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    const user = await getQuery(`SELECT * FROM usuarios WHERE id = ?`, [id]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.usuario === "admin") {
      return res.status(400).json({ error: "Use outro admin para alterar a senha do admin" });
    }
    const hash = await bcrypt.hash(nova, 10);
    await runQuery(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hash, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Gestão de usuários (admin)
app.get("/api/usuarios", requireAdmin, async (req, res) => {
  try {
    const rows = await allQuery(`SELECT id, usuario, perfil FROM usuarios ORDER BY usuario`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/usuarios", requireAdmin, async (req, res) => {
  try {
    const usuario = normalizeText(req.body.usuario);
    const senha = normalizeText(req.body.senha);
    const perfil = normalizeText(req.body.perfil || "operador");

    if (!usuario || !senha) {
      return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
    }
    const erroSenha = validarSenhaForte(senha);
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const existente = await getQuery(`SELECT id FROM usuarios WHERE usuario = ?`, [usuario]);
    if (existente) {
      return res.status(400).json({ error: "Usuário já existe" });
    }

    const hash = await bcrypt.hash(senha, 10);
    const result = await runQuery(`INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`, [
      usuario,
      hash,
      perfil === "admin" ? "admin" : "operador"
    ]);

    const id = result.id;
    const isAdmin = (perfil === "admin");
    await runQuery(
      `INSERT OR IGNORE INTO permissoes_usuarios (
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        1, 1, isAdmin ? 1 : 0, 1,
        1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/usuarios/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = await getQuery(`SELECT * FROM usuarios WHERE id = ?`, [id]);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.usuario === "admin") {
      return res.status(400).json({ error: "Não é permitido remover o usuário admin" });
    }
    await runQuery(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Permissões: obter e atualizar
app.get("/api/usuarios/:id/permissoes", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const perms = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [id]);
    if (!perms) return res.status(404).json({ error: "Permissões não encontradas" });
    res.json(perms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/usuarios/:id/permissoes", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const campos = [
      "ver_dashboard","ver_inventario","criar_editar_itens","ver_etiquetas",
      "usar_scanner","ver_movimentacoes","registrar_movimentacao","importar_exportar","gerenciar_usuarios"
    ];
    const valores = {};
    for (const c of campos) {
      if (req.body[c] !== undefined) {
        valores[c] = req.body[c] ? 1 : 0;
      }
    }
    if (Object.keys(valores).length === 0) {
      return res.status(400).json({ error: "Nenhuma permissão enviada" });
    }
    const setClause = Object.keys(valores).map(k => `${k} = ?`).join(", ");
    const params = [...Object.values(valores), id];
    await runQuery(`UPDATE permissoes_usuarios SET ${setClause} WHERE user_id = ?`, params);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/auditoria", requireAdmin, async (req, res) => {
  try {
    const limite = Math.min(Math.max(Number(req.query.limit || 25), 1), 1000);
    const usuario = normalizeText(req.query.usuario);
    const acao = normalizeText(req.query.acao);
    const dataInicio = normalizeText(req.query.data_inicio);
    const dataFim = normalizeText(req.query.data_fim);

    const where = [];
    const params = [];

    if (usuario) {
      where.push("LOWER(usuario) LIKE ?");
      params.push(`%${usuario.toLowerCase()}%`);
    }
    if (acao) {
      where.push("LOWER(acao) LIKE ?");
      params.push(`%${acao.toLowerCase()}%`);
    }
    if (dataInicio) {
      where.push("data >= ?");
      params.push(`${dataInicio} 00:00:00`);
    }
    if (dataFim) {
      where.push("data <= ?");
      params.push(`${dataFim} 23:59:59`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await allQuery(
      `SELECT id, data, usuario, acao, entidade, entidade_id, detalhes
       FROM auditoria_acoes
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`,
      [...params, limite]
    );

    const resultado = rows.map((r) => {
      let detalhes = r.detalhes;
      if (typeof detalhes === "string" && detalhes.trim().startsWith("{")) {
        try {
          detalhes = JSON.parse(detalhes);
        } catch (_) {}
      }
      return { ...r, detalhes };
    });

    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/auditoria/exportar-csv", requireAdmin, async (req, res) => {
  try {
    const usuario = normalizeText(req.query.usuario);
    const acao = normalizeText(req.query.acao);
    const dataInicio = normalizeText(req.query.data_inicio);
    const dataFim = normalizeText(req.query.data_fim);

    const where = [];
    const params = [];

    if (usuario) {
      where.push("LOWER(usuario) LIKE ?");
      params.push(`%${usuario.toLowerCase()}%`);
    }
    if (acao) {
      where.push("LOWER(acao) LIKE ?");
      params.push(`%${acao.toLowerCase()}%`);
    }
    if (dataInicio) {
      where.push("data >= ?");
      params.push(`${dataInicio} 00:00:00`);
    }
    if (dataFim) {
      where.push("data <= ?");
      params.push(`${dataFim} 23:59:59`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await allQuery(
      `SELECT id, data, usuario, acao, entidade, entidade_id, detalhes
       FROM auditoria_acoes
       ${whereSql}
       ORDER BY id DESC`,
      params
    );

    const escapeCsv = (value) => {
      const texto = String(value ?? "");
      return `"${texto.replace(/"/g, "\"\"")}"`;
    };

    const cabecalho = ["id", "data", "usuario", "acao", "entidade", "entidade_id", "detalhes"];
    const linhas = rows.map((r) =>
      [
        r.id,
        r.data,
        r.usuario,
        r.acao,
        r.entidade,
        r.entidade_id ?? "",
        r.detalhes ?? ""
      ].map(escapeCsv).join(";")
    );

    const csvConteudo = [cabecalho.join(";"), ...linhas].join("\n");
    const nomeArquivo = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nomeArquivo}"`);
    res.send("\uFEFF" + csvConteudo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/configuracoes/backup", requireAdmin, async (req, res) => {
  try {
    const habilitado = await obterConfigValor("backup_auto_habilitado", "1");
    const horario = await obterConfigValor("backup_auto_horario", "02:00");
    const reterDias = await obterConfigValor("backup_reter_dias", "15");
    res.json({
      ok: true,
      backup_auto_habilitado: Number(habilitado) === 1,
      backup_auto_horario: horario,
      backup_reter_dias: Math.max(1, Number(reterDias) || 15)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/configuracoes/backup", requireAdmin, async (req, res) => {
  try {
    const habilitado = req.body?.backup_auto_habilitado ? 1 : 0;
    const horario = normalizeText(req.body?.backup_auto_horario || "");
    const reterDias = Math.max(1, Number(req.body?.backup_reter_dias) || 15);

    if (!/^\d{2}:\d{2}$/.test(horario)) {
      return res.status(400).json({ error: "Horário inválido. Use HH:MM." });
    }

    const [hh, mm] = horario.split(":").map((v) => Number(v));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return res.status(400).json({ error: "Horário inválido." });
    }

    await definirConfigValor("backup_auto_habilitado", String(habilitado));
    await definirConfigValor("backup_auto_horario", horario);
    await definirConfigValor("backup_reter_dias", String(reterDias));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/configuracoes/backup/executar", requireAdmin, async (req, res) => {
  try {
    await executarBackupAutomatico();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// API: ITENS
// =========================
app.get("/api/itens", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        i.*,
        COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.quantidade ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN m.tipo = 'SAIDA' THEN m.quantidade ELSE 0 END), 0) AS estoque_atual
      FROM itens i
      LEFT JOIN movimentacoes m ON m.item_id = i.id
      GROUP BY i.id
      ORDER BY i.codigo
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/items", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        i.*,
        COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.quantidade ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN m.tipo = 'SAIDA' THEN m.quantidade ELSE 0 END), 0) AS estoque_atual
      FROM itens i
      LEFT JOIN movimentacoes m ON m.item_id = i.id
      GROUP BY i.id
      ORDER BY i.ferramenta
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/itens", requirePerm("criar_editar_itens"), async (req, res) => {
  try {
    const {
      codigo,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial,
      observacao
    } = req.body;

    const nomeFerramenta = normalizeText(ferramenta);

    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta é obrigatório" });
    }

    const codigoFinal = await gerarCodigoAutomatico(codigo);

    const result = await runQuery(
      `INSERT INTO itens (
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        localizacao,
        estado_inicial,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        codigoFinal,
        nomeFerramenta,
        normalizeText(categoria),
        normalizeText(marca_modelo),
        parseNumero(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
        normalizeText(observacao)
      ]
    );

    await registrarAuditoria(req, "CRIAR_ITEM", "item", result.id, {
      codigo: codigoFinal,
      ferramenta: nomeFerramenta
    });

    res.json({ ok: true, codigo: codigoFinal });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed")) {
      return res.status(400).json({ error: "Já existe um item com esse código." });
    }

    res.status(500).json({ error: e.message });
  }
});

app.post("/api/items", requirePerm("criar_editar_itens"), async (req, res) => {
  try {
    const {
      codigo,
      nome,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial,
      observacao
    } = req.body;

    const nomeFerramenta = normalizeText(ferramenta || nome);

    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta/nome é obrigatório" });
    }

    const codigoFinal = await gerarCodigoAutomatico(codigo);

    const result = await runQuery(
      `INSERT INTO itens (
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        localizacao,
        estado_inicial,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        codigoFinal,
        nomeFerramenta,
        normalizeText(categoria),
        normalizeText(marca_modelo),
        parseNumero(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
        normalizeText(observacao)
      ]
    );

    await registrarAuditoria(req, "CRIAR_ITEM", "item", result.id, {
      codigo: codigoFinal,
      ferramenta: nomeFerramenta
    });

    res.json({ ok: true, codigo: codigoFinal });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed")) {
      return res.status(400).json({ error: "Já existe um item com esse código." });
    }

    res.status(500).json({ error: e.message });
  }
});

// =========================
// API: MOVIMENTAÇÕES
// =========================
app.get("/api/movimentacoes", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        m.*,
        i.codigo,
        i.ferramenta
      FROM movimentacoes m
      JOIN itens i ON i.id = m.item_id
      ORDER BY m.id DESC
      LIMIT 300
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/movements", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        m.*,
        i.codigo,
        i.ferramenta
      FROM movimentacoes m
      JOIN itens i ON i.id = m.item_id
      ORDER BY m.id DESC
      LIMIT 300
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/movimentacoes", requirePerm("registrar_movimentacao"), async (req, res) => {
  const { item_id, tipo, quantidade, obra, funcionario, observacao } = req.body;

  if (!item_id || !tipo || quantidade === undefined || quantidade === null) {
    return res.status(400).json({
      error: "item_id, tipo e quantidade são obrigatórios"
    });
  }

  const qtd = parseNumero(quantidade);

  if (qtd <= 0) {
    return res.status(400).json({
      error: "A quantidade deve ser maior que zero"
    });
  }

  if (!["ENTRADA", "SAIDA"].includes(tipo)) {
    return res.status(400).json({
      error: "Tipo inválido. Use ENTRADA ou SAIDA"
    });
  }

  try {
    const itemExiste = await getQuery(`SELECT id FROM itens WHERE id = ?`, [item_id]);

    if (!itemExiste) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const estoqueAtual = await obterEstoqueAtual(item_id);

    if (tipo === "SAIDA" && estoqueAtual - qtd < 0) {
      return res.status(400).json({
        error: `Saída inválida. Estoque atual: ${estoqueAtual}`
      });
    }

    const result = await runQuery(
      `INSERT INTO movimentacoes (
        item_id,
        tipo,
        quantidade,
        obra,
        funcionario,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        item_id,
        tipo,
        qtd,
        normalizeText(obra),
        normalizeText(funcionario),
        normalizeText(observacao)
      ]
    );

    await registrarAuditoria(req, "REGISTRAR_MOVIMENTACAO", "movimentacao", result.id, {
      item_id: Number(item_id),
      tipo,
      quantidade: qtd
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/movements", requirePerm("registrar_movimentacao"), async (req, res) => {
  const { item_id, tipo, quantidade, obra, funcionario, observacao } = req.body;

  if (!item_id || !tipo || quantidade === undefined || quantidade === null) {
    return res.status(400).json({
      error: "item_id, tipo e quantidade são obrigatórios"
    });
  }

  const qtd = parseNumero(quantidade);

  if (qtd <= 0) {
    return res.status(400).json({
      error: "A quantidade deve ser maior que zero"
    });
  }

  if (!["ENTRADA", "SAIDA"].includes(tipo)) {
    return res.status(400).json({
      error: "Tipo inválido. Use ENTRADA ou SAIDA"
    });
  }

  try {
    const itemExiste = await getQuery(`SELECT id FROM itens WHERE id = ?`, [item_id]);

    if (!itemExiste) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const estoqueAtual = await obterEstoqueAtual(item_id);

    if (tipo === "SAIDA" && estoqueAtual - qtd < 0) {
      return res.status(400).json({
        error: `Saída inválida. Estoque atual: ${estoqueAtual}`
      });
    }

    const result = await runQuery(
      `INSERT INTO movimentacoes (
        item_id,
        tipo,
        quantidade,
        obra,
        funcionario,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        item_id,
        tipo,
        qtd,
        normalizeText(obra),
        normalizeText(funcionario),
        normalizeText(observacao)
      ]
    );

    await registrarAuditoria(req, "REGISTRAR_MOVIMENTACAO", "movimentacao", result.id, {
      item_id: Number(item_id),
      tipo,
      quantidade: qtd
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// GERAR QR CODE
// =========================
app.get("/api/qrcode/:id", requirePerm("ver_etiquetas"), async (req, res) => {
  const id = req.params.id;

  try {
    const item = await getQuery(`SELECT * FROM itens WHERE id = ?`, [id]);

    if (!item) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const conteudoQR = `UNIQ-${item.codigo || item.id}`;
    const qr = await QRCode.toDataURL(conteudoQR);

    res.json({
      qr,
      codigo: item.codigo || "",
      ferramenta: item.ferramenta || "",
      conteudo: conteudoQR
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// BUSCAR ITEM PELO QR CODE
// =========================
app.get("/api/item-qr/:codigo", requirePerm("usar_scanner"), async (req, res) => {
  const codigo = normalizeText(req.params.codigo).replace(/^(PRZ|UNIQ)-/, "");

  try {
    const item = await getQuery(
      `SELECT * FROM itens WHERE codigo = ?`,
      [codigo]
    );

    if (!item) {
      return res.status(404).json({ error: "Ferramenta não encontrada" });
    }

    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// IMPORTAR CSV / XLSX / XLS / XML
// =========================
app.post("/api/importar-csv", requirePerm("importar_exportar"), upload.single("arquivo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  try {
    const extensao = path.extname(req.file.originalname).toLowerCase();
    let linhas = [];

    if (extensao === ".xlsx" || extensao === ".xls") {
      const workbook = xlsx.readFile(req.file.path);
      const nomePrimeiraAba = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[nomePrimeiraAba];
      linhas = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
    } else if (extensao === ".csv") {
      linhas = await new Promise((resolve, reject) => {
        const registros = [];

        fs.createReadStream(req.file.path)
          .pipe(csv({ separator: ";" }))
          .on("data", (data) => registros.push(data))
          .on("end", () => resolve(registros))
          .on("error", reject);
      });
    } else if (extensao === ".xml") {
      const xmlBruto = fs.readFileSync(req.file.path, "utf8");
      linhas = parseXmlParaLinhas(xmlBruto);
      if (!linhas.length) {
        deletarArquivoSeExistir(req.file.path);
        return res.status(400).json({
          error: "XML sem registros válidos para importação."
        });
      }
    } else {
      deletarArquivoSeExistir(req.file.path);
      return res.status(400).json({
        error: "Formato não suportado. Use CSV, XLSX, XLS ou XML."
      });
    }

    const relatorio = await importarLinhasNoBanco(linhas);
    await registrarAuditoria(req, "IMPORTAR_ITENS", "item", null, {
      arquivo: req.file.originalname,
      extensao,
      total_recebido: relatorio.total_recebido,
      total_importado: relatorio.total_importado,
      total_ignorado: relatorio.total_ignorado,
      total_erros: relatorio.total_erros
    });

    deletarArquivoSeExistir(req.file.path);

    if (relatorio.total_importado === 0 && relatorio.total_erros > 0) {
      return res.status(400).json({
        error: "Nenhuma linha foi importada. Verifique o relatório de erros.",
        relatorio
      });
    }

    res.json({ ok: true, ...relatorio });
  } catch (erro) {
    deletarArquivoSeExistir(req.file?.path);

    res.status(500).json({
      error: erro.message || "Erro ao importar arquivo"
    });
  }
});

// =========================
// CORRIGIR CÓDIGOS ANTIGOS
// =========================
app.post("/api/corrigir-codigos-antigos", async (req, res) => {
  try {
    const itensSemCodigo = await allQuery(`
      SELECT id
      FROM itens
      WHERE codigo IS NULL OR TRIM(codigo) = ''
      ORDER BY id
    `);

    for (const item of itensSemCodigo) {
      const codigoGerado = `FER-${String(item.id).padStart(4, "0")}`;

      await runQuery(
        `UPDATE itens SET codigo = ? WHERE id = ?`,
        [codigoGerado, item.id]
      );
    }

    res.json({
      ok: true,
      total_corrigido: itensSemCodigo.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// DEBUG
// =========================
app.get("/api/debug-itens", requireAuth, async (req, res) => {
  try {
    const itens = await allQuery(`
      SELECT id, codigo, ferramenta
      FROM itens
      ORDER BY id
    `);

    res.json(itens);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// REORGANIZAR CÓDIGOS FER
// =========================
app.get("/api/reorganizar-codigos-fer", requireAuth, async (req, res) => {
  try {
    const itens = await allQuery(`
      SELECT id, codigo
      FROM itens
      ORDER BY id
    `);

    await runQuery("BEGIN TRANSACTION");

    for (const item of itens) {
      await runQuery(
        `UPDATE itens SET codigo = ? WHERE id = ?`,
        [`TMP-${item.id}`, item.id]
      );
    }

    let contador = 1;

    for (const item of itens) {
      const codigoNovo = `FER-${String(contador).padStart(4, "0")}`;

      await runQuery(
        `UPDATE itens SET codigo = ? WHERE id = ?`,
        [codigoNovo, item.id]
      );

      contador++;
    }

    await criarConfiguracaoSeNaoExistir("sequencia_codigo_item", String(contador));

    await runQuery(
      `UPDATE configuracoes
       SET valor = ?
       WHERE chave = 'sequencia_codigo_item'`,
      [contador]
    );

    await runQuery("COMMIT");

    res.json({
      ok: true,
      total_corrigido: itens.length,
      proximo_codigo: `FER-${String(contador).padStart(4, "0")}`
    });
  } catch (e) {
    try {
      await runQuery("ROLLBACK");
    } catch (_) {}

    res.status(500).json({ error: e.message });
  }
});

// =========================
// SINCRONIZAR SEQUÊNCIA
// =========================
app.get("/api/sincronizar-sequencia-codigos", requireAuth, async (req, res) => {
  try {
    const maior = await getQuery(`
      SELECT codigo
      FROM itens
      WHERE codigo LIKE 'FER-%'
      ORDER BY CAST(SUBSTR(codigo, 5) AS INTEGER) DESC
      LIMIT 1
    `);

    let proximo = 1;

    if (maior && maior.codigo) {
      const numero = parseInt(maior.codigo.replace("FER-", ""), 10);
      proximo = Number.isFinite(numero) ? numero + 1 : 1;
    }

    await criarConfiguracaoSeNaoExistir("sequencia_codigo_item", String(proximo));

    await runQuery(
      `UPDATE configuracoes
       SET valor = ?
       WHERE chave = 'sequencia_codigo_item'`,
      [proximo]
    );

    res.json({
      ok: true,
      proximo_codigo: `FER-${String(proximo).padStart(4, "0")}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// EXPORTAR INVENTÁRIO PARA EXCEL
// =========================
app.get("/api/exportar-inventario", requirePerm("importar_exportar"), async (req, res) => {
  try {
    const itens = await allQuery(`
      SELECT
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        localizacao,
        estado_inicial,
        observacao
      FROM itens
      ORDER BY codigo
    `);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(itens);

    xlsx.utils.book_append_sheet(wb, ws, "Inventario");

    const caminhoArquivo = path.join(BACKUP_DIR, "inventario-exportado.xlsx");
    xlsx.writeFile(wb, caminhoArquivo);

    res.download(caminhoArquivo, "inventario-exportado.xlsx");
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// INICIAR SERVIDOR
// =========================
app.listen(PORT, () => {
  console.log(`UniqStock rodando em http://localhost:${PORT}`);
});

// =========================
// BACKUP AUTOMÁTICO DIÁRIO
// =========================
let ultimoBackupAutomaticoData = "";
setInterval(async () => {
  try {
    const habilitado = await obterConfigValor("backup_auto_habilitado", "1");
    if (Number(habilitado) !== 1) return;

    const horario = await obterConfigValor("backup_auto_horario", "02:00");
    const agora = new Date();
    const hh = String(agora.getHours()).padStart(2, "0");
    const mm = String(agora.getMinutes()).padStart(2, "0");
    const horaAtual = `${hh}:${mm}`;
    const dataAtual = agora.toISOString().slice(0, 10);

    if (horaAtual !== horario) return;
    if (ultimoBackupAutomaticoData === dataAtual) return;

    await executarBackupAutomatico();
    ultimoBackupAutomaticoData = dataAtual;
  } catch (e) {
    console.error("Erro no agendador de backup:", e.message);
  }
}, 1000 * 30);
