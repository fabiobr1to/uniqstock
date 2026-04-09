require("dotenv").config();

const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const csv = require("csv-parser");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const { Readable } = require("stream");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { createDatabase } = require("./lib/database");
const { initDatabaseSchema } = require("./lib/schema");
const packageJson = require("./package.json");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// =========================
// PASTAS NECESSÃRIAS
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

const DB_CLIENT = String(process.env.DB_CLIENT || "sqlite").trim().toLowerCase();
const db = createDatabase({ sqliteFile: path.join(DB_DIR, "inventario.db") });
const upload = multer({ dest: UPLOAD_DIR });
const LICENSE_SECRET = process.env.UNIQSTOCK_LICENSE_SECRET || "uniqstock-license-secret-change";
const OFFLINE_LICENSE_GRACE_DAYS = Math.max(1, Number(process.env.UNIQSTOCK_OFFLINE_GRACE_DAYS || 30));
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const FORCE_LOCAL_LICENSE = ["1", "true", "yes", "on"].includes(
  String(process.env.UNIQSTOCK_FORCE_LOCAL_LICENSE || "").trim().toLowerCase()
);
const USE_SUPABASE_LICENSE = !FORCE_LOCAL_LICENSE && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = USE_SUPABASE_LICENSE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

if (DB_CLIENT === "postgres") {
  console.warn("DB_CLIENT=postgres detectado. Conexao e schema inicial preparados; adaptacoes de queries e migracao de dados ainda pendentes.");
}

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

// eslint-disable-next-line no-unused-vars
function gerarChaveLicenca(cliente, expiraEm, codigoMaquina = "") {
  const clienteLimpo = String(cliente || "").trim();
  const dataIso = normalizarDataIso(expiraEm);
  if (!clienteLimpo || !dataIso) {
    throw new Error("Cliente e data de expiraÃ§Ã£o vÃ¡lidos sÃ£o obrigatÃ³rios");
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
    return { ok: false, motivo: "Formato de chave invÃ¡lido" };
  }

  const payloadB64 = partes[1];
  const assinatura = partes[2];
  const esperado = assinarLicenca(payloadB64);
  const assinaturaBuf = Buffer.from(assinatura);
  const esperadoBuf = Buffer.from(esperado);

  if (assinaturaBuf.length !== esperadoBuf.length ||
      !crypto.timingSafeEqual(assinaturaBuf, esperadoBuf)) {
    return { ok: false, motivo: "Assinatura invÃ¡lida" };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64));
  } catch (_) {
    return { ok: false, motivo: "Payload da chave invÃ¡lido" };
  }

  const dataIso = normalizarDataIso(payload?.exp);
  const cliente = String(payload?.cliente || "").trim();
  const codigoMaquinaChave = String(payload?.mch || "").trim().toUpperCase();
  const codigoMaquina = String(codigoMaquinaLocal || "").trim().toUpperCase();
  if (!cliente || !dataIso) {
    return { ok: false, motivo: "Dados da chave incompletos" };
  }
  if (codigoMaquinaChave && codigoMaquinaChave !== codigoMaquina) {
    return { ok: false, motivo: "LicenÃ§a vinculada a outra mÃ¡quina" };
  }
  if (calcularDiasRestantes(dataIso) < 0) {
    return { ok: false, motivo: "LicenÃ§a expirada" };
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
        motivo: "LicenÃ§a nÃ£o ativada",
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
      motivo: "NÃ£o foi possÃ­vel validar a licenÃ§a",
      codigo_maquina: gerarCodigoMaquina(),
      provedor: "local"
    };
  }
}

async function salvarCacheLicencaSupabase({ cliente, expiraEm, codigoMaquina, validadaEm = null }) {
  await definirConfigValor("licenca_cache_cliente", String(cliente || ""));
  await definirConfigValor("licenca_cache_expira_em", String(expiraEm || ""));
  await definirConfigValor("licenca_cache_machine_code", String(codigoMaquina || ""));
  await definirConfigValor("licenca_cache_validada_em", validadaEm || new Date().toISOString());
}

async function obterStatusLicencaCacheSupabase(codigoMaquina) {
  const cliente = await obterConfigValor("licenca_cache_cliente", "");
  const expiraEm = normalizarDataIso(await obterConfigValor("licenca_cache_expira_em", ""));
  const machineCodeCache = normalizeText(await obterConfigValor("licenca_cache_machine_code", "")).toUpperCase();
  const validadaEm = normalizeText(await obterConfigValor("licenca_cache_validada_em", ""));

  if (!cliente || !expiraEm || !validadaEm) {
    return null;
  }

  if (machineCodeCache && machineCodeCache !== codigoMaquina) {
    return null;
  }

  const dataValidacao = new Date(validadaEm);
  if (Number.isNaN(dataValidacao.getTime())) {
    return null;
  }

  const diasSemValidar = Math.floor((Date.now() - dataValidacao.getTime()) / (24 * 60 * 60 * 1000));
  if (diasSemValidar > OFFLINE_LICENSE_GRACE_DAYS) {
    return {
      ativa: false,
      motivo: `LicenÃ§a offline expirada apÃ³s ${OFFLINE_LICENSE_GRACE_DAYS} dia(s) sem validaÃ§Ã£o`,
      codigo_maquina: codigoMaquina,
      provedor: "supabase-cache"
    };
  }

  const diasRestantes = calcularDiasRestantes(expiraEm);
  if (diasRestantes < 0) {
    return {
      ativa: false,
      motivo: "LicenÃ§a expirada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-cache"
    };
  }

  return {
    ativa: true,
    cliente,
    expira_em: expiraEm,
    dias_restantes: diasRestantes,
    codigo_maquina: codigoMaquina,
    provedor: "supabase-cache",
    offline: true,
    ultima_validacao_online_em: validadaEm
  };
}

async function obterStatusLicencaSupabase() {
  const codigoMaquina = gerarCodigoMaquina();
  const chave = await obterConfigValor("licenca_chave", "");
  if (!chave) {
    return {
      ativa: false,
      motivo: "LicenÃ§a nÃ£o ativada",
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
    const cache = await obterStatusLicencaCacheSupabase(codigoMaquina);
    if (cache) return cache;
    return {
      ativa: false,
      motivo: "Servidor de licenÃ§as indisponÃ­vel",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  if (!data) {
    return {
      ativa: false,
      motivo: "Chave nÃ£o encontrada no servidor de licenÃ§as",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const status = String(data.status || "").toLowerCase();
  if (status === "revoked" || status === "suspended") {
    return {
      ativa: false,
      motivo: "LicenÃ§a revogada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const expIso = normalizarDataIso(String(data.expires_at || "").slice(0, 10));
  if (!expIso || calcularDiasRestantes(expIso) < 0) {
    return {
      ativa: false,
      motivo: "LicenÃ§a expirada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const machineCodeDb = String(data.machine_code || "").trim().toUpperCase();
  if (!machineCodeDb) {
    return {
      ativa: false,
      motivo: "LicenÃ§a ainda nÃ£o ativada neste dispositivo",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  if (machineCodeDb !== codigoMaquina) {
    return {
      ativa: false,
      motivo: "LicenÃ§a vinculada a outra mÃ¡quina",
      codigo_maquina: codigoMaquina,
      provedor: "supabase"
    };
  }

  const diasRestantes = calcularDiasRestantes(expIso);
  await salvarCacheLicencaSupabase({
    cliente: String(data.client_name || "Cliente"),
    expiraEm: expIso,
    codigoMaquina,
    validadaEm: new Date().toISOString()
  });
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
    return { ok: false, error: "Servidor de licenÃ§as indisponÃ­vel", status: 503 };
  }

  if (!data) {
    return { ok: false, error: "Chave nÃ£o encontrada", status: 400 };
  }

  const status = String(data.status || "").toLowerCase();
  if (status === "revoked" || status === "suspended") {
    return { ok: false, error: "LicenÃ§a revogada", status: 400 };
  }

  const expIso = normalizarDataIso(String(data.expires_at || "").slice(0, 10));
  if (!expIso || calcularDiasRestantes(expIso) < 0) {
    return { ok: false, error: "LicenÃ§a expirada", status: 400 };
  }

  const machineCodeDb = String(data.machine_code || "").trim().toUpperCase();
  if (machineCodeDb && machineCodeDb !== codigoMaquina) {
    return { ok: false, error: "LicenÃ§a vinculada a outra mÃ¡quina", status: 400 };
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
    return { ok: false, error: "NÃ£o foi possÃ­vel ativar a licenÃ§a", status: 500 };
  }

  await definirConfigValor("licenca_ativa", "1");
  await definirConfigValor("licenca_chave", chave);
  await definirConfigValor("licenca_cliente", String(data.client_name || "Cliente"));
  await definirConfigValor("licenca_expira_em", expIso);
  await definirConfigValor("licenca_ativada_em", new Date().toISOString());
  await salvarCacheLicencaSupabase({
    cliente: String(data.client_name || "Cliente"),
    expiraEm: expIso,
    codigoMaquina,
    validadaEm: new Date().toISOString()
  });

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
      error: "LicenÃ§a nÃ£o ativada",
      codigo: "LICENCA_NAO_ATIVA",
      motivo: status.motivo
    });
  }

  if (req.path.endsWith(".html")) {
    return res.redirect("/ativacao.html");
  }

  return next();
});

// Protege a pÃ¡gina de permissÃµes no servidor (acesso direto por URL)
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

function parseDeclaredXmlEncoding(buffer) {
  const header = Buffer.from(buffer || []).subarray(0, 512).toString("ascii");
  const match = header.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i);
  return match ? String(match[1]).trim().toLowerCase() : "";
}

function scoreDecodedText(text) {
  const value = String(text || "");
  const replacement = (value.match(/\uFFFD/g) || []).length;
  const mojibake = (value.match(/Ãƒ.|Ã‚.|Ã¢â‚¬|Ã¢â‚¬Å“|Ã¢â‚¬Â|Ã¢â‚¬â„¢|Ã¢â‚¬Â¢/g) || []).length;
  const controls = Array.from(value).filter((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
  }).length;
  const accented = (value.match(/[\u00C0-\u017F]/g) || []).length;
  return (replacement * 100) + (mojibake * 20) + (controls * 5) - accented;
}

function decodeTextBuffer(buffer, options = {}) {
  const declaredXmlEncoding = options.xml ? parseDeclaredXmlEncoding(buffer) : "";
  const encodings = [
    declaredXmlEncoding,
    "utf-8",
    "windows-1252",
    "iso-8859-1",
    "latin1"
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  let best = {
    encoding: "utf-8",
    text: Buffer.from(buffer || []).toString("utf8"),
    score: Number.POSITIVE_INFINITY
  };

  encodings.forEach((encoding) => {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      const score = scoreDecodedText(text);
      if (score < best.score) {
        best = { encoding, text, score };
      }
    } catch (_) {}
  });

  return {
    encoding: best.encoding,
    text: String(best.text || "").replace(/^\uFEFF/, "")
  };
}

async function parseCsvRowsFromBuffer(buffer) {
  const { text, encoding } = decodeTextBuffer(buffer);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows = await new Promise((resolve, reject) => {
    const registros = [];
    Readable.from([normalized])
      .pipe(csv({ separator: ";" }))
      .on("data", (data) => registros.push(data))
      .on("end", () => resolve(registros))
      .on("error", reject);
  });

  return { rows, encoding };
}

const CATEGORIAS_PADRAO = [
  "Ferramenta manual",
  "Ferramenta elÃ©trica",
  "Ferramenta a bateria",
  "Ferramenta pneumÃ¡tica",
  "Ferramenta hidrÃ¡ulica",
  "Ferramenta a combustÃ£o",
  "Instrumento de mediÃ§Ã£o",
  "EPI",
  "AcessÃ³rio",
  "ConsumÃ­vel",
  "Limpeza e manutenÃ§Ã£o"
];

const LOCALIZACOES_PADRAO = [
  "Ferramentaria",
  "Almoxarifado",
  "Sala PRZ",
  "VeÃ­culo",
  "Obra",
  "Estoque externo"
];

let categoriasCustomizadas = [];
let localizacoesCustomizadas = [];

function listarCategoriasDisponiveis() {
  return [...new Set([...CATEGORIAS_PADRAO, ...categoriasCustomizadas.map((item) => normalizeText(item)).filter(Boolean)])];
}

function parseCategoriasCustomizadas(rawValue) {
  if (!rawValue) return [];
  try {
    const data = JSON.parse(String(rawValue));
    if (!Array.isArray(data)) return [];
    return [...new Set(data.map((item) => normalizeText(item)).filter(Boolean))];
  } catch (_) {
    return [];
  }
}

function listarLocalizacoesDisponiveis() {
  return [...new Set([...LOCALIZACOES_PADRAO, ...localizacoesCustomizadas.map((item) => normalizeText(item)).filter(Boolean)])];
}

function parseLocalizacoesCustomizadas(rawValue) {
  if (!rawValue) return [];
  try {
    const data = JSON.parse(String(rawValue));
    if (!Array.isArray(data)) return [];
    return [...new Set(data.map((item) => normalizeText(item)).filter(Boolean))];
  } catch (_) {
    return [];
  }
}

function normalizarTextoComparacao(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function categoriaPadronizada(categoriaInformada, ferramentaInformada = "") {
  const categoria = normalizeText(categoriaInformada);
  const ferramenta = normalizeText(ferramentaInformada);
  const categoriaBase = normalizarTextoComparacao(categoria);
  const ferramentaBase = normalizarTextoComparacao(ferramenta);

  const categoriaExistente = listarCategoriasDisponiveis().find(
    (item) => normalizarTextoComparacao(item) === categoriaBase
  );
  if (categoriaExistente) return categoriaExistente;

  if (
    ferramentaBase.includes("multimetro") ||
    ferramentaBase.includes("paquimetro") ||
    ferramentaBase.includes("trena") ||
    ferramentaBase.includes("medidor") ||
    categoriaBase.includes("medic")
  ) {
    return "Instrumento de mediÃ§Ã£o";
  }

  if (
    ferramentaBase.includes("bateria") ||
    categoriaBase.includes("bateria")
  ) {
    return "Ferramenta a bateria";
  }

  if (
    ferramentaBase.includes("pneumatic") ||
    categoriaBase.includes("pneumatic")
  ) {
    return "Ferramenta pneumÃ¡tica";
  }

  if (ferramentaBase.includes("catraca") || categoriaBase.includes("catraca")) {
    return "Ferramenta manual";
  }

  if (
    ferramentaBase.includes("hidraulic") ||
    categoriaBase.includes("hidraulic")
  ) {
    return "Ferramenta hidrÃ¡ulica";
  }

  if (
    ferramentaBase.includes("gasolina") ||
    ferramentaBase.includes("diesel") ||
    ferramentaBase.includes("combust") ||
    ferramentaBase.includes("motoserra") ||
    ferramentaBase.includes("rocadeira") ||
    categoriaBase.includes("gasolina") ||
    categoriaBase.includes("diesel") ||
    categoriaBase.includes("combust")
  ) {
    return "Ferramenta a combustÃ£o";
  }

  if (
    ferramentaBase.includes("furadeira") ||
    ferramentaBase.includes("parafusadeira") ||
    ferramentaBase.includes("esmerilhadeira") ||
    ferramentaBase.includes("serra") ||
    ferramentaBase.includes("lixadeira") ||
    ferramentaBase.includes("eletrica") ||
    categoriaBase.includes("eletric")
  ) {
    return "Ferramenta elÃ©trica";
  }

  if (ferramentaBase.includes("epi") || categoriaBase === "epi") {
    return "EPI";
  }

  if (
    categoriaBase.includes("acessorio") ||
    ferramentaBase.includes("adaptador") ||
    ferramentaBase.includes("extensao") ||
    ferramentaBase.includes("conector")
  ) {
    return "AcessÃ³rio";
  }

  if (
    categoriaBase.includes("consumivel") ||
    ferramentaBase.includes("lixa") ||
    ferramentaBase.includes("disco") ||
    ferramentaBase.includes("oleo") ||
    ferramentaBase.includes("graxa")
  ) {
    return "ConsumÃ­vel";
  }

  if (
    categoriaBase.includes("limpeza") ||
    categoriaBase.includes("manutenc") ||
    ferramentaBase.includes("desengripante") ||
    ferramentaBase.includes("limpeza")
  ) {
    return "Limpeza e manutenÃ§Ã£o";
  }

  if (
    ferramentaBase.startsWith("alicate") ||
    categoriaBase.includes("alicate") ||
    ferramentaBase.includes("chave") ||
    ferramentaBase.includes("soquete") ||
    ferramentaBase.includes("cachimbo") ||
    categoriaBase === "manual" ||
    categoriaBase.includes("chave")
  ) {
    return "Ferramenta manual";
  }

  return "AcessÃ³rio";
}

async function normalizarCategoriasExistentes() {
  const itensExistentes = await allQuery(`SELECT id, ferramenta, categoria FROM itens`);
  for (const item of itensExistentes) {
    const categoriaNova = categoriaPadronizada(item.categoria, item.ferramenta);
    if (normalizeText(item.categoria) !== categoriaNova) {
      await runQuery(`UPDATE itens SET categoria = ? WHERE id = ?`, [categoriaNova, item.id]);
    }
  }
}

function validarSenhaForte(senha) {
  const texto = String(senha || "");
  if (texto.length < 8) return "Senha deve ter ao menos 8 caracteres";
  if (!/[A-Z]/.test(texto)) return "Senha deve conter ao menos 1 letra maiÃºscula";
  if (!/[a-z]/.test(texto)) return "Senha deve conter ao menos 1 letra minÃºscula";
  if (!/[0-9]/.test(texto)) return "Senha deve conter ao menos 1 nÃºmero";
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

const ITEM_CODE_PREFIX = "PRZ";
const ALMOX_ITEM_CODE_PREFIX = "ALM";

function formatarCodigoItem(numero) {
  return `${ITEM_CODE_PREFIX}-${String(numero).padStart(4, "0")}`;
}

function formatarCodigoAlmoxItem(numero) {
  return `${ALMOX_ITEM_CODE_PREFIX}-${String(numero).padStart(4, "0")}`;
}

async function gerarCodigoAutomatico() {
  await criarConfiguracaoSeNaoExistir("sequencia_codigo_item", "1");

  const seq = await getQuery(
    `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_item'`
  );

  let numeroAtual = seq ? Number(seq.valor) : 1;
  if (!Number.isFinite(numeroAtual) || numeroAtual < 1) numeroAtual = 1;

  let codigoFinal = "";
  let encontrouLivre = false;

  while (!encontrouLivre) {
    codigoFinal = formatarCodigoItem(numeroAtual);

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

async function gerarCodigoAutomaticoAlmox() {
  await criarConfiguracaoSeNaoExistir("sequencia_codigo_almox_item", "1");

  const seq = await getQuery(
    `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_almox_item'`
  );

  let numeroAtual = seq ? Number(seq.valor) : 1;
  if (!Number.isFinite(numeroAtual) || numeroAtual < 1) numeroAtual = 1;

  let codigoDisponivel = false;

  while (!codigoDisponivel) {
    const codigoFinal = formatarCodigoAlmoxItem(numeroAtual);
    const existente = await getQuery(
      `SELECT id FROM almoxarifado_itens WHERE codigo = ?`,
      [codigoFinal]
    );

    if (!existente) {
      codigoDisponivel = true;
      await runQuery(
        `UPDATE configuracoes
         SET valor = ?
         WHERE chave = 'sequencia_codigo_almox_item'`,
        [numeroAtual + 1]
      );
      return codigoFinal;
    }

    numeroAtual++;
  }
}

async function validarCodigoDisponivelParaItem(codigoInformado, itemIdAtual = null) {
  const codigoFinal = normalizeText(codigoInformado);
  if (!codigoFinal) {
    throw new Error("O cÃ³digo do item Ã© obrigatÃ³rio");
  }

  const existente = await getQuery(
    `SELECT id FROM itens WHERE codigo = ?`,
    [codigoFinal]
  );

  if (existente && Number(existente.id) !== Number(itemIdAtual)) {
    throw new Error(`O cÃ³digo "${codigoFinal}" jÃ¡ existe.`);
  }

  return codigoFinal;
}

async function obterEstoqueAtual(itemId) {
  const item = await getQuery(
    `
    SELECT
      i.id,
      COALESCE(i.quantidade_total, 0) +
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

async function obterEstoqueAtualAlmox(itemId) {
  const item = await getQuery(
    `
    SELECT
      i.id,
      COALESCE(i.quantidade_total, 0) +
      COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.quantidade ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN m.tipo = 'SAIDA' THEN m.quantidade ELSE 0 END), 0) AS estoque_atual
    FROM almoxarifado_itens i
    LEFT JOIN almoxarifado_movimentacoes m ON m.item_id = i.id
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
    console.error("Erro ao remover arquivo temporÃ¡rio:", e.message);
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

async function carregarCategoriasCustomizadas() {
  const rawValue = await obterConfigValor("categorias_customizadas", "[]");
  categoriasCustomizadas = parseCategoriasCustomizadas(rawValue);
  return listarCategoriasDisponiveis();
}

async function carregarLocalizacoesCustomizadas() {
  const rawValue = await obterConfigValor("localizacoes_customizadas", "[]");
  localizacoesCustomizadas = parseLocalizacoesCustomizadas(rawValue);
  return listarLocalizacoesDisponiveis();
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

async function gerarPdfInventario(itens) {
  const totalCategorias = new Set(itens.map((item) => String(item.categoria || "").trim()).filter(Boolean)).size;
  const dataGeracao = new Date().toLocaleString("pt-BR");
  const fontesRegulares = [
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf"
  ];
  const fontesBold = [
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\calibrib.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf"
  ];
  const fonteRegular = fontesRegulares.find((fonte) => fs.existsSync(fonte));
  const fonteBold = fontesBold.find((fonte) => fs.existsSync(fonte)) || fonteRegular;

  if (!fonteRegular) {
    throw new Error("Nenhuma fonte TTF compatÃ­vel foi encontrada para gerar o PDF.");
  }

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 26,
    bufferPages: true
  });

  const buffers = [];
  doc.on("data", (chunk) => buffers.push(chunk));

  const fim = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  doc.registerFont("uniqstock-regular", fonteRegular);
  doc.registerFont("uniqstock-bold", fonteBold);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 26;
  const startY = 36;
  const tableX = margin;
  const colunas = [
    { key: "codigo", label: "CÃ³digo", width: 74, align: "left" },
    { key: "ferramenta", label: "Ferramenta", width: 194, align: "left" },
    { key: "categoria", label: "Categoria", width: 112, align: "left" },
    { key: "marca_modelo", label: "Marca / Modelo", width: 128, align: "left" },
    { key: "quantidade_total", label: "Qtd.", width: 42, align: "right" },
    { key: "localizacao", label: "LocalizaÃ§Ã£o", width: 136, align: "left" },
    { key: "estado_inicial", label: "Estado", width: 84, align: "left" }
  ];
  const tableWidth = colunas.reduce((sum, col) => sum + col.width, 0);
  const rowHeight = 22;
  const headerRowY = 178;
  const footerY = pageHeight - margin - 16;

  function drawHeader(paginaAtual, totalPaginas) {
    doc.save();
    doc.roundedRect(margin, startY, pageWidth - margin * 2, 72, 16).fill("#111827");
    doc.rect(margin, startY + 68, pageWidth - margin * 2, 4).fill("#d90404");

    doc.fillColor("#ffffff").font("uniqstock-bold").fontSize(23)
      .text("UniqStock | RelatÃ³rio de InventÃ¡rio", margin + 18, startY + 14, { lineBreak: false });

    doc.fillColor("#dbe7f3").font("uniqstock-regular").fontSize(10)
      .text(`Gerado em ${dataGeracao}`, margin + 18, startY + 48, { lineBreak: false });
    doc.restore();

    const cards = [
      { x: margin, title: "Itens no relatÃ³rio", value: String(itens.length) },
      { x: margin + 192, title: "Categorias", value: String(totalCategorias) },
      { x: margin + 384, title: "PÃ¡gina", value: `${paginaAtual}/${totalPaginas}` }
    ];

    cards.forEach((card) => {
      doc.save();
      doc.roundedRect(card.x, 126, 178, 42, 12).fillAndStroke("#f8fafc", "#d7e0ea");
      doc.fillColor("#64748b").font("uniqstock-regular").fontSize(9)
        .text(card.title, card.x + 12, 136, { lineBreak: false });
      doc.fillColor("#0f172a").font("uniqstock-bold").fontSize(15)
        .text(card.value, card.x + 12, 150, { lineBreak: false });
      doc.restore();
    });
  }

  function drawTableHeader() {
    doc.save();
    doc.rect(tableX, headerRowY, tableWidth, rowHeight).fill("#eef2f7");
    let x = tableX;
    colunas.forEach((col) => {
      doc.fillColor("#0f172a").font("uniqstock-bold").fontSize(9)
        .text(col.label, x + 6, headerRowY + 7, { width: col.width - 12, align: col.align });
      x += col.width;
    });
    doc.restore();
  }

  function sanitizeText(value) {
    return String(value ?? "")
      .replace(/\u00A0/g, " ")
      .replace(/\r/g, " ")
      .replace(/\n/g, " ")
      .normalize("NFC")
      .trim();
  }

  function drawRow(item, rowIndex, y) {
    if (rowIndex % 2 === 0) {
      doc.save();
      doc.rect(tableX, y, tableWidth, rowHeight).fill("#fbfcfd");
      doc.restore();
    }

    let x = tableX;
    colunas.forEach((col) => {
      const texto = sanitizeText(item[col.key] ?? "-");
      doc.fillColor("#1f2937").font("uniqstock-regular").fontSize(8.5)
        .text(texto, x + 6, y + 7, {
          width: col.width - 12,
          align: col.align,
          ellipsis: true,
          lineBreak: false
        });
      x += col.width;
    });

    doc.save();
    doc.strokeColor("#d7e0ea").lineWidth(0.5);
    doc.moveTo(tableX, y + rowHeight).lineTo(tableX + tableWidth, y + rowHeight).stroke();
    doc.restore();
  }

  function drawColumnLines(lastY) {
    let x = tableX;
    doc.save();
    doc.strokeColor("#d7e0ea").lineWidth(0.5);
    doc.rect(tableX, headerRowY, tableWidth, lastY - headerRowY).stroke();
    colunas.forEach((col) => {
      x += col.width;
      doc.moveTo(x, headerRowY).lineTo(x, lastY).stroke();
    });
    doc.restore();
  }

  function drawFooter(paginaAtual, totalPaginas) {
    doc.save();
    doc.fillColor("#64748b").font("uniqstock-regular").fontSize(8)
      .text("UniqStock | Software de GestÃ£o de Estoque", margin, footerY, { lineBreak: false });
    doc.text(`PÃ¡gina ${paginaAtual} de ${totalPaginas}`, pageWidth - margin - 80, footerY, {
      width: 80,
      align: "right",
      lineBreak: false
    });
    doc.restore();
  }

  const linhasPorPagina = 16;
  const totalPaginas = Math.max(1, Math.ceil(itens.length / linhasPorPagina));

  for (let pagina = 0; pagina < totalPaginas; pagina++) {
    if (pagina > 0) doc.addPage();
    drawHeader(pagina + 1, totalPaginas);
    drawTableHeader();

    const inicio = pagina * linhasPorPagina;
    const paginaItens = itens.slice(inicio, inicio + linhasPorPagina);
    let y = headerRowY + rowHeight;

    paginaItens.forEach((item, idx) => {
      drawRow(item, idx, y);
      y += rowHeight;
    });

    drawColumnLines(y);
  }

  for (let pagina = 0; pagina < totalPaginas; pagina++) {
    doc.switchToPage(pagina);
    drawFooter(pagina + 1, totalPaginas);
  }

  doc.end();
  return fim;
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

    // Evita nÃ³s complexos aninhados para manter parser simples e previsÃ­vel.
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
      const codigoFinal = await gerarCodigoAutomatico();

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

async function importarLinhasNoAlmoxarifado(linhas) {
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
    const numeroLinha = i + 2;
    const linha = normalizarLinhaImportacao(linhaBruta);

    if (!linhaTemConteudo(linha)) {
      relatorio.total_ignorado++;
      relatorio.ignorados.push({ linha: numeroLinha, motivo: "Linha vazia" });
      continue;
    }

    const nomeFerramenta = normalizeText(linha.ferramenta);
    if (!nomeFerramenta) {
      relatorio.total_ignorado++;
      relatorio.ignorados.push({ linha: numeroLinha, motivo: "Campo ferramenta/nome ausente" });
      continue;
    }

    try {
      const codigoFinal = await gerarCodigoAutomaticoAlmox();
      await runQuery(
        `INSERT INTO almoxarifado_itens (
          codigo,
          ferramenta,
          categoria,
          marca_modelo,
          quantidade_total,
          unidade_medida,
          embalagem,
          estoque_minimo,
          fornecedor,
          localizacao,
          estado_inicial,
          observacao
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoFinal,
          nomeFerramenta,
          categoriaPadronizada(linha.categoria, nomeFerramenta),
          normalizeText(linha.marca_modelo),
          parseNumero(linha.quantidade_total),
          normalizeText(linha.unidade_medida || "un"),
          normalizeText(linha.embalagem),
          parseNumero(linha.estoque_minimo),
          normalizeText(linha.fornecedor),
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
// CRIA??O DAS TABELAS
// =========================
initDatabaseSchema(db).catch((erro) => {
  console.error("Erro ao inicializar schema do banco:", erro.message);
});

setTimeout(async () => {
  try {
    await carregarCategoriasCustomizadas();
  } catch (erro) {
    console.error("Erro ao carregar categorias customizadas:", erro.message);
  }

  try {
    await carregarLocalizacoesCustomizadas();
  } catch (erro) {
    console.error("Erro ao carregar localizacoes customizadas:", erro.message);
  }

  try {
    await normalizarCategoriasExistentes();
  } catch (erro) {
    console.error("Erro ao normalizar categorias existentes:", erro.message);
  }
}, 300);

// =========================
// API: STATUS
// =========================
app.get("/api/status", (req, res) => {
  res.json({ ok: true, mensagem: "Servidor funcionando", db_client: DB_CLIENT });
});

app.get("/api/app/version", (req, res) => {
  res.json({ ok: true, version: packageJson.version || "0.0.0" });
});

async function obterReleaseAtualizacao(version = "") {
  if (!USE_SUPABASE_LICENSE || !supabase) {
    return { ok: false, status: 503, error: "AtualizaÃ§Ã£o remota indisponÃ­vel (Supabase nÃ£o configurado)" };
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
      return res.status(400).json({ error: "Informe a versÃ£o atual em ?current=" });
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
        error: releaseResult.error || "Erro ao consultar atualizaÃ§Ã£o",
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
      return res.status(400).json({ error: "Informe a chave de ativaÃ§Ã£o" });
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
      return res.status(400).json({ error: "UsuÃ¡rio e senha sÃ£o obrigatÃ³rios" });
    }

    if (usuario.length < 3) {
      return res.status(400).json({ error: "UsuÃ¡rio deve ter ao menos 3 caracteres" });
    }

    const erroSenha = validarSenhaForte(senha);
    if (erroSenha) {
      return res.status(400).json({ error: erroSenha });
    }

    const existente = await getQuery(`SELECT id FROM usuarios WHERE usuario = ?`, [usuario]);
    if (existente) {
      return res.status(400).json({ error: "UsuÃ¡rio jÃ¡ existe" });
    }

    const hash = await bcrypt.hash(senha, 10);
    const result = await runQuery(
      `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`,
      [usuario, hash, "operador"]
    );

    await runQuery(
      `INSERT OR IGNORE INTO permissoes_usuarios (
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0)`,
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
      error: "LicenÃ§a nÃ£o ativada. Ative o sistema para continuar.",
      codigo: "LICENCA_NAO_ATIVA",
      motivo: statusLicenca.motivo
    });
  }

  const usuario = normalizeText(req.body.usuario);
  const senha = normalizeText(req.body.senha);

  if (!usuario || !senha) {
    return res.status(400).json({ error: "UsuÃ¡rio e senha sÃ£o obrigatÃ³rios" });
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
      return res.status(401).json({ error: "UsuÃ¡rio nÃ£o encontrado" });
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

// SessÃ£o: usuÃ¡rio atual
app.get("/api/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "NÃ£o autenticado" });
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
    return res.status(401).json({ error: "NÃ£o autenticado" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "NÃ£o autenticado" });
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
  // criar padrÃ£o conforme perfil
  const isAdmin = user.perfil === "admin";
  await runQuery(
    `INSERT OR IGNORE INTO permissoes_usuarios (
      user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
      usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, 1,
      1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0
    ]
  );
  const created = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [user.id]);
  return { user, perms: created };
}

app.get("/api/minhas-permissoes", requireAuth, async (req, res) => {
  try {
    const info = await getUserPerms(req.session.user.usuario);
    if (!info) return res.status(404).json({ error: "UsuÃ¡rio nÃ£o encontrado" });
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
      return res.status(401).json({ error: "NÃ£o autenticado" });
    }
    try {
      const info = await getUserPerms(req.session.user.usuario);
      if (!info) return res.status(401).json({ error: "NÃ£o autenticado" });
      if (info.user.perfil === "admin") return next();
      if (info.perms && info.perms[permissao] === 1) return next();
      return res.status(403).json({ error: "PermissÃ£o negada" });
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

// Alterar senha (usuÃ¡rio logado)
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
    if (!user) return res.status(404).json({ error: "UsuÃ¡rio nÃ£o encontrado" });
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

// Resetar senha (admin escolhe usuÃ¡rio)
app.post("/api/usuarios/:id/reset-senha", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { senha_nova } = req.body || {};
    const nova = normalizeText(senha_nova);
    if (!nova) return res.status(400).json({ error: "Informe a nova senha" });
    const erroSenha = validarSenhaForte(nova);
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    const user = await getQuery(`SELECT * FROM usuarios WHERE id = ?`, [id]);
    if (!user) return res.status(404).json({ error: "UsuÃ¡rio nÃ£o encontrado" });
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
// GestÃ£o de usuÃ¡rios (admin)
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
      return res.status(400).json({ error: "UsuÃ¡rio e senha sÃ£o obrigatÃ³rios" });
    }
    const erroSenha = validarSenhaForte(senha);
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const existente = await getQuery(`SELECT id FROM usuarios WHERE usuario = ?`, [usuario]);
    if (existente) {
      return res.status(400).json({ error: "UsuÃ¡rio jÃ¡ existe" });
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
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, 1,
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
    if (!user) return res.status(404).json({ error: "UsuÃ¡rio nÃ£o encontrado" });
    if (user.usuario === "admin") {
      return res.status(400).json({ error: "NÃ£o Ã© permitido remover o usuÃ¡rio admin" });
    }
    await runQuery(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PermissÃµes: obter e atualizar
app.get("/api/usuarios/:id/permissoes", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const perms = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [id]);
    if (!perms) return res.status(404).json({ error: "PermissÃµes nÃ£o encontradas" });
    res.json(perms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/usuarios/:id/permissoes", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const campos = [
      "ver_dashboard","ver_inventario","criar_editar_itens","criar_itens","editar_itens","excluir_itens","ver_etiquetas",
      "usar_scanner","ver_movimentacoes","registrar_movimentacao","importar_exportar","gerenciar_usuarios"
    ];
    const valores = {};
    for (const c of campos) {
      if (req.body[c] !== undefined) {
        valores[c] = req.body[c] ? 1 : 0;
      }
    }
    if (Object.keys(valores).length === 0) {
      return res.status(400).json({ error: "Nenhuma permissÃ£o enviada" });
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

app.get("/api/categorias", requireAuth, async (req, res) => {
  try {
    await carregarCategoriasCustomizadas();
    return res.json({
      ok: true,
      categorias: listarCategoriasDisponiveis(),
      padrao: CATEGORIAS_PADRAO,
      customizadas: categoriasCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao carregar categorias" });
  }
});

app.get("/api/localizacoes", requireAuth, async (req, res) => {
  try {
    await carregarLocalizacoesCustomizadas();
    return res.json({
      ok: true,
      localizacoes: listarLocalizacoesDisponiveis(),
      padrao: LOCALIZACOES_PADRAO,
      customizadas: localizacoesCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao carregar localizaÃ§Ãµes" });
  }
});

app.get("/api/configuracoes/categorias", requireAdmin, async (req, res) => {
  try {
    await carregarCategoriasCustomizadas();
    return res.json({
      ok: true,
      categorias: listarCategoriasDisponiveis(),
      padrao: CATEGORIAS_PADRAO,
      customizadas: categoriasCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao carregar categorias" });
  }
});

app.get("/api/configuracoes/localizacoes", requireAdmin, async (req, res) => {
  try {
    await carregarLocalizacoesCustomizadas();
    return res.json({
      ok: true,
      localizacoes: listarLocalizacoesDisponiveis(),
      padrao: LOCALIZACOES_PADRAO,
      customizadas: localizacoesCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao carregar localizaÃ§Ãµes" });
  }
});

app.put("/api/configuracoes/categorias", requireAdmin, async (req, res) => {
  try {
    const categorias = Array.isArray(req.body?.categorias) ? req.body.categorias : [];
    categoriasCustomizadas = [...new Set(
      categorias
        .map((item) => normalizeText(item))
        .filter(Boolean)
        .filter((item) => !CATEGORIAS_PADRAO.some((padrao) => normalizarTextoComparacao(padrao) === normalizarTextoComparacao(item)))
    )];

    await definirConfigValor("categorias_customizadas", JSON.stringify(categoriasCustomizadas));

    return res.json({
      ok: true,
      categorias: listarCategoriasDisponiveis(),
      padrao: CATEGORIAS_PADRAO,
      customizadas: categoriasCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao salvar categorias" });
  }
});

app.put("/api/configuracoes/localizacoes", requireAdmin, async (req, res) => {
  try {
    const localizacoes = Array.isArray(req.body?.localizacoes) ? req.body.localizacoes : [];
    localizacoesCustomizadas = [...new Set(
      localizacoes
        .map((item) => normalizeText(item))
        .filter(Boolean)
        .filter((item) => !LOCALIZACOES_PADRAO.some((padrao) => normalizarTextoComparacao(padrao) === normalizarTextoComparacao(item)))
    )];

    await definirConfigValor("localizacoes_customizadas", JSON.stringify(localizacoesCustomizadas));

    return res.json({
      ok: true,
      localizacoes: listarLocalizacoesDisponiveis(),
      padrao: LOCALIZACOES_PADRAO,
      customizadas: localizacoesCustomizadas
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao salvar localizaÃ§Ãµes" });
  }
});

app.get("/api/configuracoes/estoque", requireAuth, async (req, res) => {
  try {
    const limite = Math.max(1, Number(await obterConfigValor("estoque_baixo_limite", "2")) || 2);
    res.json({
      ok: true,
      estoque_baixo_limite: limite
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
      return res.status(400).json({ error: "HorÃ¡rio invÃ¡lido. Use HH:MM." });
    }

    const [hh, mm] = horario.split(":").map((v) => Number(v));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return res.status(400).json({ error: "HorÃ¡rio invÃ¡lido." });
    }

    await definirConfigValor("backup_auto_habilitado", String(habilitado));
    await definirConfigValor("backup_auto_horario", horario);
    await definirConfigValor("backup_reter_dias", String(reterDias));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/configuracoes/estoque", requireAdmin, async (req, res) => {
  try {
    const limite = Math.max(1, Number(req.body?.estoque_baixo_limite) || 2);
    await definirConfigValor("estoque_baixo_limite", String(limite));
    res.json({ ok: true, estoque_baixo_limite: limite });
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
        COALESCE(i.quantidade_total, 0) +
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
        COALESCE(i.quantidade_total, 0) +
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

app.post("/api/itens", requirePerm("criar_itens"), async (req, res) => {
  try {
    const {
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
      return res.status(400).json({ error: "O campo ferramenta Ã© obrigatÃ³rio" });
    }

    const codigoFinal = await gerarCodigoAutomatico();

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
        categoriaPadronizada(categoria, nomeFerramenta),
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
      return res.status(400).json({ error: "JÃ¡ existe um item com esse cÃ³digo." });
    }

    res.status(500).json({ error: e.message });
  }
});

app.post("/api/items", requirePerm("criar_itens"), async (req, res) => {
  try {
    const {
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
      return res.status(400).json({ error: "O campo ferramenta/nome Ã© obrigatÃ³rio" });
    }

    const codigoFinal = await gerarCodigoAutomatico();

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
        categoriaPadronizada(categoria, nomeFerramenta),
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
      return res.status(400).json({ error: "JÃ¡ existe um item com esse cÃ³digo." });
    }

    res.status(500).json({ error: e.message });
  }
});

app.put("/api/itens/:id", requirePerm("editar_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT * FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

    const {
      codigo,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial,
      observacao
    } = req.body || {};

    const nomeFerramenta = normalizeText(ferramenta);
    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta Ã© obrigatÃ³rio" });
    }

    const codigoFinal = await validarCodigoDisponivelParaItem(codigo || itemAtual.codigo, id);

    await runQuery(
      `UPDATE itens
       SET codigo = ?, ferramenta = ?, categoria = ?, marca_modelo = ?, quantidade_total = ?,
           localizacao = ?, estado_inicial = ?, observacao = ?
       WHERE id = ?`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseNumero(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
        normalizeText(observacao),
        id
      ]
    );

    await registrarAuditoria(req, "EDITAR_ITEM", "item", id, {
      codigo: codigoFinal,
      ferramenta: nomeFerramenta
    });

    return res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed")) {
      return res.status(400).json({ error: "JÃ¡ existe um item com esse cÃ³digo." });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.put("/api/items/:id", requirePerm("editar_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT * FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

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
    } = req.body || {};

    const nomeFerramenta = normalizeText(ferramenta || nome);
    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta/nome Ã© obrigatÃ³rio" });
    }

    const codigoFinal = await validarCodigoDisponivelParaItem(codigo || itemAtual.codigo, id);

    await runQuery(
      `UPDATE itens
       SET codigo = ?, ferramenta = ?, categoria = ?, marca_modelo = ?, quantidade_total = ?,
           localizacao = ?, estado_inicial = ?, observacao = ?
       WHERE id = ?`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseNumero(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
        normalizeText(observacao),
        id
      ]
    );

    await registrarAuditoria(req, "EDITAR_ITEM", "item", id, {
      codigo: codigoFinal,
      ferramenta: nomeFerramenta
    });

    return res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed")) {
      return res.status(400).json({ error: "JÃ¡ existe um item com esse cÃ³digo." });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/api/itens/:id", requirePerm("excluir_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT id, codigo, ferramenta FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

    const movimentacoes = await getQuery(
      `SELECT COUNT(*) AS total FROM movimentacoes WHERE item_id = ?`,
      [id]
    );

    if (Number(movimentacoes?.total || 0) > 0) {
      return res.status(400).json({
        error: "NÃ£o Ã© possÃ­vel excluir itens com histÃ³rico de movimentaÃ§Ãµes."
      });
    }

    await runQuery(`DELETE FROM itens WHERE id = ?`, [id]);

    await registrarAuditoria(req, "EXCLUIR_ITEM", "item", id, {
      codigo: itemAtual.codigo,
      ferramenta: itemAtual.ferramenta
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/api/items/:id", requirePerm("excluir_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT id, codigo, ferramenta FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

    const movimentacoes = await getQuery(
      `SELECT COUNT(*) AS total FROM movimentacoes WHERE item_id = ?`,
      [id]
    );

    if (Number(movimentacoes?.total || 0) > 0) {
      return res.status(400).json({
        error: "NÃ£o Ã© possÃ­vel excluir itens com histÃ³rico de movimentaÃ§Ãµes."
      });
    }

    await runQuery(`DELETE FROM itens WHERE id = ?`, [id]);

    await registrarAuditoria(req, "EXCLUIR_ITEM", "item", id, {
      codigo: itemAtual.codigo,
      ferramenta: itemAtual.ferramenta
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =========================
// API: MOVIMENTAÃ‡Ã•ES
// =========================
app.get("/api/almoxarifado/itens", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        i.*,
        COALESCE(i.quantidade_total, 0) +
        COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.quantidade ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN m.tipo = 'SAIDA' THEN m.quantidade ELSE 0 END), 0) AS estoque_atual
      FROM almoxarifado_itens i
      LEFT JOIN almoxarifado_movimentacoes m ON m.item_id = i.id
      GROUP BY i.id
      ORDER BY i.codigo
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/almoxarifado/itens", requirePerm("criar_itens"), async (req, res) => {
  try {
    const {
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      unidade_medida,
      embalagem,
      estoque_minimo,
      fornecedor,
      localizacao,
      estado_inicial,
      observacao
    } = req.body || {};

    const nomeMaterial = normalizeText(ferramenta);
    if (!nomeMaterial) {
      return res.status(400).json({ error: "O campo material é obrigatório" });
    }

    const codigoFinal = await gerarCodigoAutomaticoAlmox();
    await runQuery(
      `INSERT INTO almoxarifado_itens (
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        unidade_medida,
        embalagem,
        estoque_minimo,
        fornecedor,
        localizacao,
        estado_inicial,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        codigoFinal,
        nomeMaterial,
        categoriaPadronizada(categoria, nomeMaterial),
        normalizeText(marca_modelo),
        parseNumero(quantidade_total),
        normalizeText(unidade_medida || "un"),
        normalizeText(embalagem),
        parseNumero(estoque_minimo),
        normalizeText(fornecedor),
        normalizeText(localizacao || "Almoxarifado"),
        normalizeText(estado_inicial),
        normalizeText(observacao)
      ]
    );

    await registrarAuditoria(req, "CRIAR_ITEM_ALMOX", "almoxarifado_item", null, {
      codigo: codigoFinal,
      ferramenta: nomeMaterial
    });

    res.json({ ok: true, codigo: codigoFinal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/almoxarifado/movimentacoes", requireAuth, async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        m.*,
        i.codigo,
        i.ferramenta
      FROM almoxarifado_movimentacoes m
      JOIN almoxarifado_itens i ON i.id = m.item_id
      ORDER BY m.id DESC
      LIMIT 300
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/almoxarifado/movimentacoes", requirePerm("registrar_movimentacao"), async (req, res) => {
  const { item_id, tipo, quantidade, obra, funcionario, observacao } = req.body;

  if (!item_id || !tipo || quantidade === undefined || quantidade === null) {
    return res.status(400).json({ error: "item_id, tipo e quantidade são obrigatórios" });
  }

  const qtd = parseNumero(quantidade);
  if (qtd <= 0) {
    return res.status(400).json({ error: "A quantidade deve ser maior que zero" });
  }

  if (!["ENTRADA", "SAIDA"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo inválido. Use ENTRADA ou SAIDA" });
  }

  try {
    const itemExiste = await getQuery(`SELECT id FROM almoxarifado_itens WHERE id = ?`, [item_id]);
    if (!itemExiste) {
      return res.status(404).json({ error: "Material do almoxarifado não encontrado" });
    }

    const estoqueAtual = await obterEstoqueAtualAlmox(item_id);
    if (tipo === "SAIDA" && estoqueAtual - qtd < 0) {
      return res.status(400).json({ error: `Saída inválida. Estoque atual: ${estoqueAtual}` });
    }

    const result = await runQuery(
      `INSERT INTO almoxarifado_movimentacoes (item_id, tipo, quantidade, obra, funcionario, observacao)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [item_id, tipo, qtd, normalizeText(obra), normalizeText(funcionario), normalizeText(observacao)]
    );

    await registrarAuditoria(req, "REGISTRAR_MOVIMENTACAO_ALMOX", "almoxarifado_movimentacao", result.id, {
      item_id: Number(item_id),
      tipo,
      quantidade: qtd
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
      error: "item_id, tipo e quantidade sÃ£o obrigatÃ³rios"
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
      error: "Tipo invÃ¡lido. Use ENTRADA ou SAIDA"
    });
  }

  try {
    const itemExiste = await getQuery(`SELECT id FROM itens WHERE id = ?`, [item_id]);

    if (!itemExiste) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

    const estoqueAtual = await obterEstoqueAtual(item_id);

    if (tipo === "SAIDA" && estoqueAtual - qtd < 0) {
      return res.status(400).json({
        error: `SaÃ­da invÃ¡lida. Estoque atual: ${estoqueAtual}`
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
      error: "item_id, tipo e quantidade sÃ£o obrigatÃ³rios"
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
      error: "Tipo invÃ¡lido. Use ENTRADA ou SAIDA"
    });
  }

  try {
    const itemExiste = await getQuery(`SELECT id FROM itens WHERE id = ?`, [item_id]);

    if (!itemExiste) {
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
    }

    const estoqueAtual = await obterEstoqueAtual(item_id);

    if (tipo === "SAIDA" && estoqueAtual - qtd < 0) {
      return res.status(400).json({
        error: `SaÃ­da invÃ¡lida. Estoque atual: ${estoqueAtual}`
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
      return res.status(404).json({ error: "Item nÃ£o encontrado" });
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
  const codigo = normalizeText(req.params.codigo).replace(/^UNIQ-/, "");

  try {
    const item = await getQuery(
      `SELECT * FROM itens WHERE codigo = ?`,
      [codigo]
    );

    if (!item) {
      return res.status(404).json({ error: "Ferramenta nÃ£o encontrada" });
    }

    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// IMPORTAR CSV / XLSX / XLS / XML
// =========================
app.post("/api/importar-almoxarifado", requirePerm("importar_exportar"), upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado" });
    }

    const extensao = path.extname(req.file.originalname).toLowerCase();
    let linhas = [];
    let encodingDetectado = "";

    if (extensao === ".xlsx" || extensao === ".xls") {
      const workbook = xlsx.readFile(req.file.path);
      const nomePrimeiraAba = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[nomePrimeiraAba];
      linhas = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
    } else if (extensao === ".csv") {
      const csvBuffer = fs.readFileSync(req.file.path);
      const csvResult = await parseCsvRowsFromBuffer(csvBuffer);
      linhas = csvResult.rows;
      encodingDetectado = csvResult.encoding;
    } else if (extensao === ".xml") {
      const xmlBuffer = fs.readFileSync(req.file.path);
      const xmlResult = decodeTextBuffer(xmlBuffer, { xml: true });
      const xmlBruto = xmlResult.text;
      encodingDetectado = xmlResult.encoding;
      linhas = parseXmlParaLinhas(xmlBruto);
      if (!linhas.length) {
        deletarArquivoSeExistir(req.file.path);
        return res.status(400).json({ error: "XML sem registros válidos para importação." });
      }
    } else {
      deletarArquivoSeExistir(req.file.path);
      return res.status(400).json({ error: "Formato não suportado. Use CSV, XLSX, XLS ou XML." });
    }

    const relatorio = await importarLinhasNoAlmoxarifado(linhas);
    await registrarAuditoria(req, "IMPORTAR_ALMOXARIFADO", "almoxarifado_item", null, {
      arquivo: req.file.originalname,
      extensao,
      encoding_detectado: encodingDetectado || null,
      total_recebido: relatorio.total_recebido,
      total_importado: relatorio.total_importado,
      total_ignorado: relatorio.total_ignorado,
      total_erros: relatorio.total_erros
    });

    deletarArquivoSeExistir(req.file.path);
    res.json({ ok: true, encoding_detectado: encodingDetectado || null, inventario: "almoxarifado", ...relatorio });
  } catch (e) {
    deletarArquivoSeExistir(req.file?.path);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/importar-csv", requirePerm("importar_exportar"), upload.single("arquivo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  try {
    const extensao = path.extname(req.file.originalname).toLowerCase();
    let linhas = [];
    let encodingDetectado = "";

    if (extensao === ".xlsx" || extensao === ".xls") {
      const workbook = xlsx.readFile(req.file.path);
      const nomePrimeiraAba = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[nomePrimeiraAba];
      linhas = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
    } else if (extensao === ".csv") {
      const csvBuffer = fs.readFileSync(req.file.path);
      const csvResult = await parseCsvRowsFromBuffer(csvBuffer);
      linhas = csvResult.rows;
      encodingDetectado = csvResult.encoding;
    } else if (extensao === ".xml") {
      const xmlBuffer = fs.readFileSync(req.file.path);
      const xmlResult = decodeTextBuffer(xmlBuffer, { xml: true });
      const xmlBruto = xmlResult.text;
      encodingDetectado = xmlResult.encoding;
      linhas = parseXmlParaLinhas(xmlBruto);
      if (!linhas.length) {
        deletarArquivoSeExistir(req.file.path);
        return res.status(400).json({
          error: "XML sem registros vÃ¡lidos para importaÃ§Ã£o."
        });
      }
    } else {
      deletarArquivoSeExistir(req.file.path);
      return res.status(400).json({
        error: "Formato nÃ£o suportado. Use CSV, XLSX, XLS ou XML."
      });
    }

    const relatorio = await importarLinhasNoBanco(linhas);
    await registrarAuditoria(req, "IMPORTAR_ITENS", "item", null, {
      arquivo: req.file.originalname,
      extensao,
      encoding_detectado: encodingDetectado || null,
      total_recebido: relatorio.total_recebido,
      total_importado: relatorio.total_importado,
      total_ignorado: relatorio.total_ignorado,
      total_erros: relatorio.total_erros
    });

    deletarArquivoSeExistir(req.file.path);

    if (relatorio.total_importado === 0 && relatorio.total_erros > 0) {
      return res.status(400).json({
        error: "Nenhuma linha foi importada. Verifique o relatÃ³rio de erros.",
        relatorio
      });
    }

    res.json({ ok: true, encoding_detectado: encodingDetectado || null, ...relatorio });
  } catch (erro) {
    deletarArquivoSeExistir(req.file?.path);

    res.status(500).json({
      error: erro.message || "Erro ao importar arquivo"
    });
  }
});

// =========================
// CORRIGIR CÃ“DIGOS ANTIGOS
// =========================
app.post("/api/corrigir-codigos-antigos", requireAdmin, async (req, res) => {
  try {
    const itensSemCodigo = await allQuery(`
      SELECT id
      FROM itens
      WHERE codigo IS NULL OR TRIM(codigo) = ''
      ORDER BY id
    `);

    for (const item of itensSemCodigo) {
      const codigoGerado = formatarCodigoItem(item.id);

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
app.get("/api/debug-itens", requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.status(404).json({ error: "Rota indisponivel" });
  }

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
// REORGANIZAR CÃ“DIGOS
// =========================
app.get("/api/reorganizar-codigos-fer", requireAdmin, async (req, res) => {
  try {
    const itens = await allQuery(`
      SELECT id, codigo
      FROM itens
      ORDER BY id
    `);

    let contador = 1;

    await db.withTransaction(async () => {
      for (const item of itens) {
        await runQuery(
          `UPDATE itens SET codigo = ? WHERE id = ?`,
          [`TMP-${item.id}`, item.id]
        );
      }

      for (const item of itens) {
        const codigoNovo = formatarCodigoItem(contador);

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
    });

    res.json({
      ok: true,
      total_corrigido: itens.length,
      proximo_codigo: formatarCodigoItem(contador)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// SINCRONIZAR SEQUÃŠNCIA
// =========================
app.get("/api/sincronizar-sequencia-codigos", requireAdmin, async (req, res) => {
  try {
    const maior = await getQuery(`
      SELECT codigo
      FROM itens
      WHERE codigo LIKE '${ITEM_CODE_PREFIX}-%'
      ORDER BY CAST(SUBSTR(codigo, ${ITEM_CODE_PREFIX.length + 2}) AS INTEGER) DESC
      LIMIT 1
    `);

    let proximo = 1;

    if (maior && maior.codigo) {
      const numero = parseInt(maior.codigo.replace(`${ITEM_CODE_PREFIX}-`, ""), 10);
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
      proximo_codigo: formatarCodigoItem(proximo)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// EXPORTAR INVENTÃRIO PARA PDF
// =========================
app.get("/api/exportar-almoxarifado", requirePerm("importar_exportar"), async (req, res) => {
  try {
    const itens = await allQuery(`
      SELECT
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        localizacao,
        estado_inicial
      FROM almoxarifado_itens
      ORDER BY codigo ASC
    `);

    const pdfBuffer = await gerarPdfInventario(itens);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="almoxarifado-exportado.pdf"');
    return res.end(pdfBuffer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.get("/api/exportar-inventario", requirePerm("importar_exportar"), async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);

    const params = [];
    const where = ids.length ? `WHERE id IN (${ids.map(() => "?").join(",")})` : "";
    if (ids.length) params.push(...ids);

    const itens = await allQuery(`
      SELECT
        codigo,
        ferramenta,
        categoria,
        marca_modelo,
        quantidade_total,
        localizacao,
        estado_inicial
      FROM itens
      ${where}
      ORDER BY codigo
    `, params);

    const pdf = await gerarPdfInventario(itens);
    const nomeArquivo = ids.length ? "inventario-selecionados.pdf" : "inventario-exportado.pdf";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${nomeArquivo}"`);
    res.send(pdf);
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
// BACKUP AUTOMÃTICO DIÃRIO
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

