const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const csv = require("csv-parser");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const xlsx = require("xlsx");
const zlib = require("zlib");
const PDFDocument = require("pdfkit");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Readable } = require("stream");
const { createClient } = require("@supabase/supabase-js");
const packageJson = require("./package.json");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.UNIQSTOCK_BIND_HOST || "127.0.0.1").trim() || "127.0.0.1";

// =========================
// PASTAS NECESSÁRIAS
// =========================
const RUNTIME_BASE_DIR = process.env.UNIQSTOCK_RUNTIME_DIR
  ? path.resolve(process.env.UNIQSTOCK_RUNTIME_DIR)
  : __dirname;
const DB_DIR = path.join(RUNTIME_BASE_DIR, "db");
const DB_PATH = path.join(DB_DIR, "inventario.db");
const UPLOAD_DIR = path.join(RUNTIME_BASE_DIR, "uploads");
const BACKUP_DIR = path.join(RUNTIME_BASE_DIR, "backups");
const UPDATES_DIR = path.join(RUNTIME_BASE_DIR, "updates");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(UPDATES_DIR)) fs.mkdirSync(UPDATES_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);
if (typeof db.configure === "function") {
  db.configure("busyTimeout", 5000);
}
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});
const LICENSE_SECRET = process.env.UNIQSTOCK_LICENSE_SECRET || "uniqstock-license-secret-change";
const OFFLINE_LICENSE_GRACE_DAYS = Math.max(1, Number(process.env.UNIQSTOCK_OFFLINE_GRACE_DAYS || 30));
const COMMERCIAL_API_URL = String(process.env.UNIQSTOCK_COMMERCIAL_API_URL || "").trim().replace(/\/+$/, "");
const COMMERCIAL_API_TOKEN = String(process.env.UNIQSTOCK_COMMERCIAL_API_TOKEN || "").trim();
const APP_PACKAGED = String(process.env.UNIQSTOCK_APP_PACKAGED || "").trim() === "1";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_COMMERCIAL_API = Boolean(COMMERCIAL_API_URL);
const USE_LEGACY_SUPABASE_LICENSE = !USE_COMMERCIAL_API && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = USE_LEGACY_SUPABASE_LICENSE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;
const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim() || crypto.randomBytes(32).toString("hex");
const SESSION_MAX_AGE_MS = Math.max(60 * 60 * 1000, Number(process.env.UNIQSTOCK_SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000));
const SESSION_CLEANUP_INTERVAL_MS = Math.max(5 * 60 * 1000, Number(process.env.UNIQSTOCK_SESSION_CLEANUP_INTERVAL_MS || 30 * 60 * 1000));
const REQUIRE_SIGNED_INSTALLER = String(process.env.UNIQSTOCK_REQUIRE_SIGNED_INSTALLER || "1").trim() !== "0";
const UPDATE_ALLOWED_HOSTS = String(process.env.UNIQSTOCK_UPDATE_ALLOWED_HOSTS || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS_PER_IP = 30;
const LOGIN_MAX_ATTEMPTS_PER_USER_IP = 8;
const loginAttemptsByIp = new Map();
const loginAttemptsByUserIp = new Map();

if (!String(process.env.SESSION_SECRET || "").trim()) {
  console.warn("SESSION_SECRET não definido. Um segredo aleatório temporário será usado nesta execução.");
}
if (SUPABASE_SERVICE_ROLE_KEY && !USE_LEGACY_SUPABASE_LICENSE) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY presente, mas desativada no runtime atual.");
}
if (APP_PACKAGED && SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY detectada em app empacotado. Isso não deve ocorrer em builds comerciais.");
}

class SqliteSessionStore extends session.Store {
  constructor({ db: database, tableName = "app_sessions", ttlMs = SESSION_MAX_AGE_MS }) {
    super();
    this.db = database;
    this.tableName = tableName;
    this.ttlMs = ttlMs;
    this.init();
  }

  init() {
    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires_at
        ON ${this.tableName}(expires_at)
      `);
    });
  }

  getExpiresAt(sess) {
    const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : 0;
    if (Number.isFinite(cookieExpires) && cookieExpires > Date.now()) {
      return cookieExpires;
    }
    return Date.now() + this.ttlMs;
  }

  get(sid, callback) {
    this.db.get(
      `SELECT data, expires_at FROM ${this.tableName} WHERE sid = ?`,
      [sid],
      (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(null, null);
        if (Number(row.expires_at || 0) <= Date.now()) {
          return this.destroy(sid, () => callback(null, null));
        }

        try {
          return callback(null, JSON.parse(row.data));
        } catch (parseError) {
          return callback(parseError);
        }
      }
    );
  }

  set(sid, sess, callback = () => {}) {
    const expiresAt = this.getExpiresAt(sess);
    let data = "";

    try {
      data = JSON.stringify(sess);
    } catch (err) {
      return callback(err);
    }

    this.db.run(
      `INSERT INTO ${this.tableName} (sid, data, expires_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(sid) DO UPDATE SET
         data = excluded.data,
         expires_at = excluded.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
      [sid, data, expiresAt],
      (err) => callback(err || null)
    );
  }

  touch(sid, sess, callback = () => {}) {
    const expiresAt = this.getExpiresAt(sess);
    this.db.run(
      `UPDATE ${this.tableName}
       SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE sid = ?`,
      [expiresAt, sid],
      (err) => callback(err || null)
    );
  }

  destroy(sid, callback = () => {}) {
    this.db.run(
      `DELETE FROM ${this.tableName} WHERE sid = ?`,
      [sid],
      (err) => callback(err || null)
    );
  }

  cleanupExpired(callback = () => {}) {
    this.db.run(
      `DELETE FROM ${this.tableName} WHERE expires_at <= ?`,
      [Date.now()],
      (err) => callback(err || null)
    );
  }
}

const sessionStore = new SqliteSessionStore({ db });
const sessionCleanupTimer = setInterval(() => {
  sessionStore.cleanupExpired((err) => {
    if (err) {
      console.error("Erro ao limpar sessões expiradas:", err.message);
    }
  });
}, SESSION_CLEANUP_INTERVAL_MS);
if (typeof sessionCleanupTimer.unref === "function") {
  sessionCleanupTimer.unref();
}

app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self)");
  next();
});
app.use(
  session({
    name: "uniqstock.sid",
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: SESSION_MAX_AGE_MS
    }
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

async function salvarCacheLicencaRemota({ cliente, expiraEm, codigoMaquina, validadaEm = null }) {
  await definirConfigValor("licenca_cache_cliente", String(cliente || ""));
  await definirConfigValor("licenca_cache_expira_em", String(expiraEm || ""));
  await definirConfigValor("licenca_cache_machine_code", String(codigoMaquina || ""));
  await definirConfigValor("licenca_cache_validada_em", validadaEm || new Date().toISOString());
}

async function obterStatusLicencaCacheRemota(codigoMaquina, provedor = "api-cache") {
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
      motivo: `Licença offline expirada após ${OFFLINE_LICENSE_GRACE_DAYS} dia(s) sem validação`,
      codigo_maquina: codigoMaquina,
      provedor
    };
  }

  const diasRestantes = calcularDiasRestantes(expiraEm);
  if (diasRestantes < 0) {
    return {
      ativa: false,
      motivo: "Licença expirada",
      codigo_maquina: codigoMaquina,
      provedor
    };
  }

  return {
    ativa: true,
    cliente,
    expira_em: expiraEm,
    dias_restantes: diasRestantes,
    codigo_maquina: codigoMaquina,
    provedor,
    offline: true,
    ultima_validacao_online_em: validadaEm
  };
}

function cabecalhosApiComercial(extra = {}) {
  const headers = {
    Accept: "application/json",
    ...extra
  };

  if (COMMERCIAL_API_TOKEN) {
    headers.Authorization = `Bearer ${COMMERCIAL_API_TOKEN}`;
  }

  return headers;
}

async function requisicaoApiComercialJson(method, endpoint, payload = null) {
  if (!USE_COMMERCIAL_API) {
    return { ok: false, status: 503, error: "API comercial não configurada" };
  }

  const url = new URL(endpoint.replace(/^\//, ""), `${COMMERCIAL_API_URL}/`);
  const headers = cabecalhosApiComercial();
  let body = undefined;

  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body
    });
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: "Servidor comercial indisponível",
      detalhe: e.message
    };
  }

  let data = null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    data = await response.json().catch(() => null);
  } else {
    const texto = await response.text().catch(() => "");
    data = texto ? { error: texto } : null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data?.error || data?.message || `Falha na API comercial (${response.status})`,
      detalhe: data?.detalhe || data?.detail || ""
    };
  }

  return {
    ok: true,
    status: response.status,
    data
  };
}

function normalizarStatusLicencaRemota(data, codigoMaquina, provedor) {
  const ativa = Boolean(data?.ativa);
  const cliente = normalizeText(data?.cliente || data?.client_name || "");
  const expiraEm = normalizarDataIso(String(data?.expira_em || data?.expires_at || "").slice(0, 10));
  const machineCode = normalizeText(data?.codigo_maquina || data?.machine_code || codigoMaquina).toUpperCase() || codigoMaquina;
  const motivo = normalizeText(data?.motivo || data?.error || data?.message);

  if (!ativa) {
    return {
      ativa: false,
      motivo: motivo || "Licença não ativa",
      codigo_maquina: codigoMaquina,
      provedor
    };
  }

  if (!cliente || !expiraEm) {
    return {
      ativa: false,
      motivo: "Resposta inválida do servidor de licenças",
      codigo_maquina: codigoMaquina,
      provedor
    };
  }

  if (machineCode && machineCode !== codigoMaquina) {
    return {
      ativa: false,
      motivo: "Licença vinculada a outra máquina",
      codigo_maquina: codigoMaquina,
      provedor
    };
  }

  const diasRestantesInformados = Number(data?.dias_restantes);
  return {
    ativa: true,
    cliente,
    expira_em: expiraEm,
    dias_restantes: Number.isFinite(diasRestantesInformados) ? diasRestantesInformados : calcularDiasRestantes(expiraEm),
    codigo_maquina: codigoMaquina,
    provedor
  };
}

async function persistirLicencaAtiva({ chave, cliente, expiraEm, provedor, codigoMaquina = "" }) {
  await definirConfigValor("licenca_ativa", "1");
  await definirConfigValor("licenca_chave", chave);
  await definirConfigValor("licenca_cliente", cliente);
  await definirConfigValor("licenca_expira_em", expiraEm);
  await definirConfigValor("licenca_ativada_em", new Date().toISOString());
  await definirConfigValor("licenca_provedor", provedor);

  if (codigoMaquina) {
    await salvarCacheLicencaRemota({
      cliente,
      expiraEm,
      codigoMaquina,
      validadaEm: new Date().toISOString()
    });
  }
}

async function obterStatusLicencaApi() {
  const codigoMaquina = gerarCodigoMaquina();
  const chave = await obterConfigValor("licenca_chave", "");
  if (!chave) {
    return {
      ativa: false,
      motivo: "Licença não ativada",
      codigo_maquina: codigoMaquina,
      provedor: "api"
    };
  }

  const resultado = await requisicaoApiComercialJson("POST", "/api/licenses/status", {
    license_key: chave,
    machine_code: codigoMaquina,
    app_version: String(packageJson.version || ""),
    build_version: String(packageJson.buildVersion || "")
  });

  if (!resultado.ok) {
    const cache = await obterStatusLicencaCacheRemota(codigoMaquina, "api-cache");
    if (cache) return cache;
    return {
      ativa: false,
      motivo: resultado.error || "Servidor comercial indisponível",
      codigo_maquina: codigoMaquina,
      provedor: "api"
    };
  }

  const status = normalizarStatusLicencaRemota(resultado.data || {}, codigoMaquina, "api");
  if (status.ativa) {
    await salvarCacheLicencaRemota({
      cliente: status.cliente,
      expiraEm: status.expira_em,
      codigoMaquina,
      validadaEm: new Date().toISOString()
    });
  }
  return status;
}

async function obterStatusLicencaSupabase() {
  const codigoMaquina = gerarCodigoMaquina();
  const chave = await obterConfigValor("licenca_chave", "");
  if (!chave) {
    return {
      ativa: false,
      motivo: "Licença não ativada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  const { data, error } = await supabase
    .from("licenses")
    .select("license_key, client_name, machine_code, expires_at, status, activated_at")
    .eq("license_key", chave)
    .maybeSingle();

  if (error) {
    const cache = await obterStatusLicencaCacheRemota(codigoMaquina, "supabase-cache");
    if (cache) return cache;
    return {
      ativa: false,
      motivo: "Servidor de licenças indisponível",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  if (!data) {
    return {
      ativa: false,
      motivo: "Chave não encontrada no servidor de licenças",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  const status = String(data.status || "").toLowerCase();
  if (status === "revoked" || status === "suspended") {
    return {
      ativa: false,
      motivo: "Licença revogada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  const expIso = normalizarDataIso(String(data.expires_at || "").slice(0, 10));
  if (!expIso || calcularDiasRestantes(expIso) < 0) {
    return {
      ativa: false,
      motivo: "Licença expirada",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  const machineCodeDb = String(data.machine_code || "").trim().toUpperCase();
  if (!machineCodeDb) {
    return {
      ativa: false,
      motivo: "Licença ainda não ativada neste dispositivo",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  if (machineCodeDb !== codigoMaquina) {
    return {
      ativa: false,
      motivo: "Licença vinculada a outra máquina",
      codigo_maquina: codigoMaquina,
      provedor: "supabase-legacy"
    };
  }

  const diasRestantes = calcularDiasRestantes(expIso);
  await salvarCacheLicencaRemota({
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
    provedor: "supabase-legacy"
  };
}

async function ativarLicencaLocal(chave) {
  const validacao = validarChaveLicenca(chave, gerarCodigoMaquina());
  if (!validacao.ok) {
    return { ok: false, error: validacao.motivo, status: 400 };
  }

  await persistirLicencaAtiva({
    chave,
    cliente: validacao.payload.cliente,
    expiraEm: validacao.payload.exp,
    provedor: "local"
  });

  return {
    ok: true,
    cliente: validacao.payload.cliente,
    expira_em: validacao.payload.exp,
    provedor: "local"
  };
}

async function ativarLicencaApi(chave) {
  const codigoMaquina = gerarCodigoMaquina();
  const resultado = await requisicaoApiComercialJson("POST", "/api/licenses/activate", {
    license_key: chave,
    machine_code: codigoMaquina,
    app_version: String(packageJson.version || ""),
    build_version: String(packageJson.buildVersion || "")
  });

  if (!resultado.ok) {
    return {
      ok: false,
      error: resultado.error || "Servidor comercial indisponível",
      status: resultado.status || 503
    };
  }

  const data = resultado.data || {};
  const status = normalizarStatusLicencaRemota(
    {
      ativa: true,
      cliente: data.cliente || data.client_name,
      expira_em: data.expira_em || data.expires_at,
      dias_restantes: data.dias_restantes,
      codigo_maquina: data.codigo_maquina || data.machine_code || codigoMaquina
    },
    codigoMaquina,
    "api"
  );

  if (!status.ativa) {
    return { ok: false, error: status.motivo, status: 400 };
  }

  await persistirLicencaAtiva({
    chave,
    cliente: status.cliente,
    expiraEm: status.expira_em,
    provedor: "api",
    codigoMaquina
  });

  return {
    ok: true,
    cliente: status.cliente,
    expira_em: status.expira_em,
    provedor: "api"
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

  await persistirLicencaAtiva({
    chave,
    cliente: String(data.client_name || "Cliente"),
    expiraEm: expIso,
    provedor: "supabase-legacy",
    codigoMaquina
  });

  return {
    ok: true,
    cliente: String(data.client_name || "Cliente"),
    expira_em: expIso,
    provedor: "supabase-legacy"
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

async function inferirProvedorLicencaAtual() {
  const configurado = normalizeText(await obterConfigValor("licenca_provedor", ""));
  if (configurado) return configurado;

  const chave = await obterConfigValor("licenca_chave", "");
  if (!chave) return "local";

  const validacaoLocal = validarChaveLicenca(chave, gerarCodigoMaquina());
  if (validacaoLocal.ok) return "local";

  if (USE_COMMERCIAL_API) return "api";
  if (USE_LEGACY_SUPABASE_LICENSE) return "supabase-legacy";

  const cache = await obterStatusLicencaCacheRemota(gerarCodigoMaquina(), "api-cache");
  if (cache) return "api";

  return "local";
}

function normalizarChaveTentativaLogin(valor) {
  return String(valor || "").trim().toLowerCase();
}

function limparMapaTentativasLogin(mapa, agora = Date.now()) {
  for (const [chave, registro] of mapa.entries()) {
    if (!registro || !registro.ts || (agora - registro.ts) > LOGIN_RATE_LIMIT_WINDOW_MS) {
      mapa.delete(chave);
    }
  }
}

function registrarTentativaLoginFalha(mapa, chave, agora = Date.now()) {
  if (!chave) return;
  limparMapaTentativasLogin(mapa, agora);
  const registro = mapa.get(chave);
  if (!registro || (agora - registro.ts) > LOGIN_RATE_LIMIT_WINDOW_MS) {
    mapa.set(chave, { count: 1, ts: agora });
    return;
  }
  registro.count += 1;
  registro.ts = agora;
  mapa.set(chave, registro);
}

function limparTentativasLoginFalha(usuario, ip) {
  const usuarioNormalizado = normalizarChaveTentativaLogin(usuario);
  const ipNormalizado = normalizarChaveTentativaLogin(ip);
  if (ipNormalizado) loginAttemptsByIp.delete(ipNormalizado);
  if (usuarioNormalizado && ipNormalizado) {
    loginAttemptsByUserIp.delete(`${ipNormalizado}::${usuarioNormalizado}`);
  }
}

function obterBloqueioLogin(usuario, ip, agora = Date.now()) {
  limparMapaTentativasLogin(loginAttemptsByIp, agora);
  limparMapaTentativasLogin(loginAttemptsByUserIp, agora);

  const usuarioNormalizado = normalizarChaveTentativaLogin(usuario);
  const ipNormalizado = normalizarChaveTentativaLogin(ip);
  if (!ipNormalizado) return 0;

  const registroIp = loginAttemptsByIp.get(ipNormalizado);
  if (registroIp && registroIp.count >= LOGIN_MAX_ATTEMPTS_PER_IP) {
    return Math.max(0, LOGIN_RATE_LIMIT_WINDOW_MS - (agora - registroIp.ts));
  }

  if (!usuarioNormalizado) return 0;

  const registroUsuarioIp = loginAttemptsByUserIp.get(`${ipNormalizado}::${usuarioNormalizado}`);
  if (registroUsuarioIp && registroUsuarioIp.count >= LOGIN_MAX_ATTEMPTS_PER_USER_IP) {
    return Math.max(0, LOGIN_RATE_LIMIT_WINDOW_MS - (agora - registroUsuarioIp.ts));
  }

  return 0;
}

function registrarFalhaLogin(usuario, ip, agora = Date.now()) {
  const usuarioNormalizado = normalizarChaveTentativaLogin(usuario);
  const ipNormalizado = normalizarChaveTentativaLogin(ip);
  if (ipNormalizado) registrarTentativaLoginFalha(loginAttemptsByIp, ipNormalizado, agora);
  if (usuarioNormalizado && ipNormalizado) {
    registrarTentativaLoginFalha(loginAttemptsByUserIp, `${ipNormalizado}::${usuarioNormalizado}`, agora);
  }
}

async function obterStatusLicenca() {
  const agora = Date.now();
  if (cacheLicenca.valor && cacheLicenca.expiraEmMs > agora) {
    return cacheLicenca.valor;
  }

  const provedor = await inferirProvedorLicencaAtual();
  let status;

  if (provedor === "api" && USE_COMMERCIAL_API) {
    status = await obterStatusLicencaApi();
  } else if (provedor === "supabase-legacy" && USE_LEGACY_SUPABASE_LICENSE) {
    status = await obterStatusLicencaSupabase();
  } else if (provedor === "api") {
    status = await obterStatusLicencaCacheRemota(gerarCodigoMaquina(), "api-cache");
    if (!status) {
      status = {
        ativa: false,
        motivo: "API comercial não configurada para validar a licença remota",
        codigo_maquina: gerarCodigoMaquina(),
        provedor: "api"
      };
    }
  } else if (provedor === "supabase-legacy") {
    status = await obterStatusLicencaCacheRemota(gerarCodigoMaquina(), "supabase-cache");
    if (!status) {
      status = {
        ativa: false,
        motivo: "Validação remota legada indisponível neste runtime",
        codigo_maquina: gerarCodigoMaquina(),
        provedor: "supabase-legacy"
      };
    }
  } else {
    status = await obterStatusLicencaLocal();
  }

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

function obterOrigensConfiaveis(req) {
  const hostHeader = normalizeText(req.get("host")).toLowerCase();
  const origens = new Set([
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    `https://localhost:${PORT}`
  ]);

  if (hostHeader) {
    origens.add(`http://${hostHeader}`);
    origens.add(`https://${hostHeader}`);
  }

  return origens;
}

function origemEhConfiavel(req, valor) {
  const texto = normalizeText(valor);
  if (!texto) return false;

  try {
    const origem = new URL(texto).origin.toLowerCase();
    return obterOrigensConfiaveis(req).has(origem);
  } catch (_) {
    return false;
  }
}

function secFetchSiteEhConfiavel(req) {
  const secFetchSite = normalizeText(req.get("sec-fetch-site")).toLowerCase();
  return secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none";
}

async function rotaMutavelDispensaValidacaoOrigem(req) {
  if (!req.path.startsWith("/api/")) return true;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return true;
  if (req.path === "/api/login") return true;

  if (req.path === "/api/licenca/ativar") {
    const licencaJaConfigurada = normalizeText(await obterConfigValor("licenca_chave", "")) !== "";
    return !licencaJaConfigurada;
  }

  return false;
}

app.use(async (req, res, next) => {
  if (await rotaMutavelDispensaValidacaoOrigem(req)) {
    return next();
  }

  const origin = normalizeText(req.get("origin"));
  const referer = normalizeText(req.get("referer"));
  const origemValida = origin
    ? origemEhConfiavel(req, origin)
    : (referer ? origemEhConfiavel(req, referer) : secFetchSiteEhConfiavel(req));

  if (origemValida) {
    return next();
  }

  console.warn(
    `Requisição mutável bloqueada por origem inválida: ${req.method} ${req.path} origin=${origin || "-"} referer=${referer || "-"}`
  );
  return res.status(403).json({ error: "Origem da requisição não permitida" });
});

async function enviarPaginaAdmin(req, res, pagina) {
  try {
    const user = await obterUsuarioSessaoAtual(req);
    if (!user) {
      destruirSessaoSilenciosamente(req);
      return res.redirect("/login.html");
    }
    if (user.perfil !== "admin") {
      return res.redirect("/acesso-negado.html");
    }
    return res.sendFile(path.join(__dirname, "public", pagina));
  } catch (_) {
    destruirSessaoSilenciosamente(req);
    return res.redirect("/login.html");
  }
}

app.get("/permissoes.html", (req, res) => enviarPaginaAdmin(req, res, "permissoes.html"));
app.get("/auditoria.html", (req, res) => enviarPaginaAdmin(req, res, "auditoria.html"));
app.get("/configuracoes.html", (req, res) => enviarPaginaAdmin(req, res, "configuracoes.html"));
app.get("/usuarios.html", (req, res) => enviarPaginaAdmin(req, res, "usuarios.html"));
app.get("/cadastro.html", (req, res) => enviarPaginaAdmin(req, res, "cadastro.html"));

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

function createDbConnection() {
  const connection = new sqlite3.Database(DB_PATH);
  if (typeof connection.configure === "function") {
    connection.configure("busyTimeout", 5000);
  }
  return connection;
}

function createConnectionHelpers(connection) {
  return {
    runQuery(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID, changes: this.changes });
        });
      });
    },
    getQuery(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.get(sql, params, (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
    },
    allQuery(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      });
    }
  };
}

async function closeDbConnection(connection) {
  await new Promise((resolve) => {
    connection.close(() => resolve());
  });
}

function normalizeText(value) {
  return value ? String(value).trim() : "";
}

async function obterUsuarioSessaoAtual(req) {
  const usuarioSessao = normalizeText(req?.session?.user?.usuario);
  if (!usuarioSessao) return null;

  const user = await getQuery(
    `SELECT id, usuario, perfil, sessao_versao FROM usuarios WHERE usuario = ?`,
    [usuarioSessao]
  );

  if (!user) return null;

  const versaoSessao = Number(req?.session?.user?.sessao_versao);
  const versaoAtual = Number(user?.sessao_versao || 0);

  if (!Number.isFinite(versaoSessao) || versaoSessao !== versaoAtual) {
    return null;
  }

  if (!req.session.user ||
      req.session.user.usuario !== user.usuario ||
      req.session.user.perfil !== user.perfil ||
      Number(req.session.user.sessao_versao) !== versaoAtual) {
    req.session.user = { usuario: user.usuario, perfil: user.perfil, sessao_versao: versaoAtual };
  }

  return user;
}

function destruirSessaoSilenciosamente(req) {
  try {
    req.session?.destroy(() => {});
  } catch (_) {}
}

const CATEGORIAS_PADRONIZADAS = [
  "Medição",
  "Alicate",
  "Chave",
  "Soquete",
  "Catraca",
  "Elétrica",
  "Acessório",
  "EPI",
  "Tubulação",
  "Refrigeração e hidráulica",
  "Insumo"
];

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

  const categoriaExistente = CATEGORIAS_PADRONIZADAS.find(
    (item) => normalizarTextoComparacao(item) === categoriaBase
  );
  if (categoriaExistente) return categoriaExistente;

  if (categoriaBase) {
    if (categoriaBase.includes("medic")) return "Medição";
    if (categoriaBase.includes("alicate")) return "Alicate";
    if (categoriaBase.includes("soquete") || categoriaBase.includes("cachimbo")) return "Soquete";
    if (categoriaBase.includes("catraca")) return "Catraca";
    if (categoriaBase.includes("eletric")) return "Elétrica";
    if (categoriaBase === "epi") return "EPI";
    if (categoriaBase.includes("acessorio")) return "Acessório";
    if (categoriaBase === "manual" || categoriaBase.includes("chave")) return "Chave";
    return categoria;
  }

  if (
    ferramentaBase.includes("multimetro") ||
    ferramentaBase.includes("paquimetro") ||
    ferramentaBase.includes("trena") ||
    ferramentaBase.includes("medidor")
  ) {
    return "Medição";
  }

  if (ferramentaBase.startsWith("alicate")) return "Alicate";

  if (
    ferramentaBase.includes("soquete") ||
    ferramentaBase.includes("cachimbo")
  ) {
    return "Soquete";
  }

  if (ferramentaBase.includes("catraca")) return "Catraca";

  if (
    ferramentaBase.includes("furadeira") ||
    ferramentaBase.includes("parafusadeira") ||
    ferramentaBase.includes("esmerilhadeira") ||
    ferramentaBase.includes("serra") ||
    ferramentaBase.includes("lixadeira") ||
    ferramentaBase.includes("eletrica")
  ) {
    return "Elétrica";
  }

  if (ferramentaBase.includes("epi")) return "EPI";

  if (
    ferramentaBase.includes("adaptador") ||
    ferramentaBase.includes("extensao") ||
    ferramentaBase.includes("conector")
  ) {
    return "Acessório";
  }

  if (ferramentaBase.includes("chave")) {
    return "Chave";
  }

  return "Acessório";
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
  if (!/[A-Z]/.test(texto)) return "Senha deve conter ao menos 1 letra maiúscula";
  if (!/[a-z]/.test(texto)) return "Senha deve conter ao menos 1 letra minúscula";
  if (!/[0-9]/.test(texto)) return "Senha deve conter ao menos 1 número";
  if (!/[^A-Za-z0-9]/.test(texto)) return "Senha deve conter ao menos 1 caractere especial";
  return null;
}

async function migrarSenhasTextoPuro() {
  const usuarios = await allQuery(`SELECT id, usuario, senha FROM usuarios`);

  for (const usuario of usuarios) {
    const senhaAtual = String(usuario?.senha || "");
    if (!senhaAtual || senhaAtual.startsWith("$2")) continue;

    const hash = await bcrypt.hash(senhaAtual, 10);
    await runQuery(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hash, usuario.id]);
    console.log(`Senha migrada para bcrypt: ${usuario.usuario}`);
  }
}

async function bootstrapAdminInicialSeguro() {
  const totalUsuarios = await getQuery(`SELECT COUNT(*) AS total FROM usuarios`);
  if (Number(totalUsuarios?.total || 0) > 0) return;

  const senhaBootstrap = String(process.env.UNIQSTOCK_BOOTSTRAP_ADMIN_PASSWORD || "").trim();
  if (!senhaBootstrap) {
    console.warn("Nenhum usuário existe. Defina UNIQSTOCK_BOOTSTRAP_ADMIN_PASSWORD para criar o admin inicial.");
    return;
  }

  const erroSenha = validarSenhaForte(senhaBootstrap);
  if (erroSenha) {
    console.error(`UNIQSTOCK_BOOTSTRAP_ADMIN_PASSWORD inválida: ${erroSenha}`);
    return;
  }

  const hash = await bcrypt.hash(senhaBootstrap, 10);
  const result = await runQuery(
    `INSERT INTO usuarios (usuario, senha, perfil) VALUES (?, ?, ?)`,
    ["admin", hash, "admin"]
  );

  await runQuery(
    `INSERT OR IGNORE INTO permissoes_usuarios (
      user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
      usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
    ) VALUES (?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`,
    [result.id]
  );

  console.warn("Usuário admin inicial criado com senha vinda de UNIQSTOCK_BOOTSTRAP_ADMIN_PASSWORD.");
}

function parseNumero(value) {
  const texto = String(value ?? "").trim().replace(",", ".");
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function parseQuantidadeTotalItem(value) {
  const textoOriginal = String(value ?? "").trim();

  if (!textoOriginal) return 0;

  let texto = textoOriginal.replace(/\s+/g, "");

  if (/^-?\d{1,3}(\.\d{3})+$/.test(texto)) {
    texto = texto.replace(/\./g, "");
  } else if (/^-?\d{1,3}(,\d{3})+$/.test(texto)) {
    texto = texto.replace(/,/g, "");
  } else if (texto.includes(".") && texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else if (texto.includes(",")) {
    texto = texto.replace(",", ".");
  }

  const numero = Number(texto);

  if (!Number.isFinite(numero)) {
    throw criarErroValidacao("Quantidade total inválida.");
  }

  if (numero < 0) {
    throw criarErroValidacao("A quantidade total não pode ser negativa.");
  }

  return numero;
}

function parseQuantidadeImportacao(value) {
  const textoOriginal = String(value ?? "").trim();

  if (!textoOriginal) return 1;

  let texto = textoOriginal.replace(/\s+/g, "");
  if (texto.includes(".") && texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else {
    texto = texto.replace(",", ".");
  }

  const numero = Number(texto);

  if (!Number.isFinite(numero) || numero <= 0) {
    throw criarErroValidacao("A quantidade deve ser um número maior que zero.");
  }

  return numero;
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

function criarExecutorBanco(executor = null) {
  return executor || { runQuery, getQuery, allQuery };
}

async function criarConfiguracaoSeNaoExistir(chave, valor, executor = null) {
  const banco = criarExecutorBanco(executor);
  const existente = await banco.getQuery(
    `SELECT chave FROM configuracoes WHERE chave = ?`,
    [chave]
  );

  if (!existente) {
    await banco.runQuery(
      `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)`,
      [chave, String(valor)]
    );
  }
}

async function gerarCodigoAutomatico(codigoInformado, executor = null) {
  const codigoManual = normalizarCodigo(codigoInformado);
  const banco = criarExecutorBanco(executor);

  if (codigoManual) {
    validarFormatoCodigo(codigoManual);

    const existente = await buscarItemPorCodigoNormalizado(codigoManual, null, banco);

    if (existente) {
      throw criarErroValidacao(`O código "${codigoManual}" já existe.`);
    }

    return codigoManual;
  }

  if (!executor) {
    return executarTransacaoExclusiva(async (trx) => gerarCodigoAutomatico("", trx));
  }

  await criarConfiguracaoSeNaoExistir("sequencia_codigo_item", "1", banco);

  const seq = await banco.getQuery(
    `SELECT valor FROM configuracoes WHERE chave = 'sequencia_codigo_item'`
  );

  let numeroAtual = seq ? Number(seq.valor) : 1;
  if (!Number.isFinite(numeroAtual) || numeroAtual < 1) numeroAtual = 1;

  let codigoFinal = "";
  let encontrouLivre = false;

  while (!encontrouLivre) {
    codigoFinal = `FER-${String(numeroAtual).padStart(4, "0")}`;

    const existente = await buscarItemPorCodigoNormalizado(codigoFinal, null, banco);

    if (!existente) {
      encontrouLivre = true;
    } else {
      numeroAtual++;
    }
  }

  await banco.runQuery(
    `UPDATE configuracoes
     SET valor = ?
     WHERE chave = 'sequencia_codigo_item'`,
    [numeroAtual + 1]
  );

  return codigoFinal;
}

async function validarCodigoDisponivelParaItem(codigoInformado, itemIdAtual = null) {
  const codigoFinal = normalizarCodigo(codigoInformado);
  if (!codigoFinal) {
    throw criarErroValidacao("O código do item é obrigatório");
  }

  validarFormatoCodigo(codigoFinal);

  const existente = await buscarItemPorCodigoNormalizado(codigoFinal, itemIdAtual);

  if (existente) {
    throw criarErroValidacao(`O código "${codigoFinal}" já existe.`);
  }

  return codigoFinal;
}

async function executarTransacaoExclusiva(executor) {
  const connection = createDbConnection();
  const trx = createConnectionHelpers(connection);
  let transacaoAberta = false;

  try {
    await trx.runQuery(`PRAGMA foreign_keys = ON`);
    await trx.runQuery("BEGIN IMMEDIATE TRANSACTION");
    transacaoAberta = true;

    const resultado = await executor(trx);

    await trx.runQuery("COMMIT");
    transacaoAberta = false;
    return resultado;
  } catch (erro) {
    if (transacaoAberta) {
      try {
        await trx.runQuery("ROLLBACK");
      } catch (_) {}
    }
    throw erro;
  } finally {
    await closeDbConnection(connection);
  }
}

async function registrarMovimentacaoAtomica({ itemId, tipo, quantidade, obra, funcionario, observacao }) {
  return executarTransacaoExclusiva(async (trx) => {
    const item = await trx.getQuery(
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

    if (!item) {
      throw criarErroHttp(404, "Item não encontrado");
    }

    const estoqueAtual = Number(item.estoque_atual || 0);
    if (tipo === "SAIDA" && estoqueAtual - quantidade < 0) {
      throw criarErroValidacao(`Saída inválida. Estoque atual: ${estoqueAtual}`);
    }

    const result = await trx.runQuery(
      `INSERT INTO movimentacoes (
        item_id,
        tipo,
        quantidade,
        obra,
        funcionario,
        observacao
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        tipo,
        quantidade,
        normalizeText(obra),
        normalizeText(funcionario),
        normalizeText(observacao)
      ]
    );

    return { id: result.id };
  });
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

function abrirConexaoSqlite(caminhoBanco) {
  return new Promise((resolve, reject) => {
    const conexao = new sqlite3.Database(caminhoBanco, (err) => {
      if (err) return reject(err);
      if (typeof conexao.configure === "function") {
        conexao.configure("busyTimeout", 5000);
      }
      resolve(conexao);
    });
  });
}

function execSqlite(conexao, sql) {
  return new Promise((resolve, reject) => {
    conexao.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function getSqlite(conexao, sql, params = []) {
  return new Promise((resolve, reject) => {
    conexao.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function closeSqlite(conexao) {
  return new Promise((resolve, reject) => {
    conexao.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function literalSqlite(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`;
}

async function verificarIntegridadeArquivoSqlite(caminhoArquivo) {
  const conexao = await abrirConexaoSqlite(caminhoArquivo);
  try {
    const row = await getSqlite(conexao, "PRAGMA integrity_check");
    const resultado = String(Object.values(row || {})[0] || "").trim();
    if (resultado.toLowerCase() !== "ok") {
      throw new Error(`Integridade do backup inválida: ${resultado || "sem resposta"}`);
    }
    return "ok";
  } finally {
    await closeSqlite(conexao).catch(() => {});
  }
}

async function fazerBackupBanco() {
  const data = new Date().toISOString().replace(/[:.]/g, "-");
  const destinoTemporario = path.join(BACKUP_DIR, `inventario-backup-${data}.tmp.db`);
  const destinoFinal = path.join(BACKUP_DIR, `inventario-backup-${data}.db`);
  deletarArquivoSeExistir(destinoTemporario);
  deletarArquivoSeExistir(destinoFinal);

  const conexao = await abrirConexaoSqlite(DB_PATH);
  try {
    await execSqlite(conexao, `VACUUM INTO ${literalSqlite(destinoTemporario)}`);
  } catch (e) {
    deletarArquivoSeExistir(destinoTemporario);
    throw new Error(`Erro ao criar snapshot do banco: ${e.message}`);
  } finally {
    await closeSqlite(conexao).catch(() => {});
  }

  try {
    const integrityCheck = await verificarIntegridadeArquivoSqlite(destinoTemporario);
    await fs.promises.rename(destinoTemporario, destinoFinal);
    const stat = await fs.promises.stat(destinoFinal);
    return {
      path: destinoFinal,
      file_name: path.basename(destinoFinal),
      size_bytes: stat.size,
      integrity_check: integrityCheck,
      created_at: new Date().toISOString()
    };
  } catch (e) {
    deletarArquivoSeExistir(destinoTemporario);
    deletarArquivoSeExistir(destinoFinal);
    throw e;
  }
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

async function obterUltimoBackupDisponivel() {
  const arquivos = await listarArquivosBackup();
  let ultimo = null;

  for (const arquivo of arquivos) {
    try {
      const stat = await fs.promises.stat(arquivo);
      if (!ultimo || stat.mtimeMs > ultimo.stat.mtimeMs) {
        ultimo = { arquivo, stat };
      }
    } catch (_) {}
  }

  if (!ultimo) return null;
  return {
    path: ultimo.arquivo,
    file_name: path.basename(ultimo.arquivo),
    size_bytes: ultimo.stat.size,
    modified_at: new Date(ultimo.stat.mtimeMs).toISOString()
  };
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
  const backup = await fazerBackupBanco();
  const reterDias = await obterConfigValor("backup_reter_dias", "15");
  await limparBackupsAntigos(reterDias);
  return backup;
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

  };

  if (mapa[chave]) return mapa[chave];

  // Fallbacks por prefixo para planilhas com sufixos variados.
  if (chave.startsWith("cod")) return "codigo";
  if (chave.startsWith("qtd") || chave.startsWith("qtde") || chave.startsWith("quant")) return "quantidade_total";
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

function normalizarTextoChaveConteudo(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function criarChaveConteudoItem(item) {
  return [
    item.ferramenta,
    item.categoria,
    item.marca_modelo,
    item.localizacao
  ].map(normalizarTextoChaveConteudo).join("|");
}

function valueOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizarCodigo(codigo) {
  return String(codigo || "")
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

function criarErroValidacao(mensagem) {
  const erro = new Error(mensagem);
  erro.statusCode = 400;
  return erro;
}

function criarErroHttp(statusCode, mensagem) {
  const erro = new Error(mensagem);
  erro.statusCode = statusCode;
  return erro;
}

function validarFormatoCodigo(codigoNormalizado) {
  if (!codigoNormalizado) return;

  const formatoValido = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(codigoNormalizado)
    && /[A-Z]/.test(codigoNormalizado)
    && /\d/.test(codigoNormalizado);

  if (!formatoValido) {
    throw criarErroValidacao(
      'O código deve usar apenas letras maiúsculas, números e hífen, por exemplo "FER-0001".'
    );
  }
}

async function buscarItemPorCodigoNormalizado(codigoNormalizado, itemIdIgnorado = null, executor = null) {
  if (!codigoNormalizado) return null;

  const banco = criarExecutorBanco(executor);
  const itens = await banco.allQuery(
    `SELECT id, codigo FROM itens WHERE codigo IS NOT NULL AND TRIM(codigo) <> ''`
  );

  return itens.find((item) => {
    const codigoItem = normalizarCodigo(item.codigo);
    if (!codigoItem || codigoItem !== codigoNormalizado) return false;
    if (itemIdIgnorado !== null && Number(item.id) === Number(itemIdIgnorado)) return false;
    return true;
  }) || null;
}

async function carregarItensPorChaveConteudo(executor = null) {
  const banco = criarExecutorBanco(executor);
  const itens = await banco.allQuery(`
    SELECT id, codigo, ferramenta, categoria, marca_modelo, quantidade_total, localizacao
    FROM itens
  `);
  const mapa = new Map();

  for (const item of itens) {
    const chave = criarChaveConteudoItem({
      ferramenta: normalizeText(item.ferramenta),
      categoria: categoriaPadronizada(item.categoria, item.ferramenta),
      marca_modelo: normalizeText(item.marca_modelo),
      localizacao: normalizeText(item.localizacao)
    });

    const lista = mapa.get(chave) || [];
    lista.push({
      id: item.id,
      codigo: normalizarCodigo(item.codigo),
      quantidade_total: parseNumero(item.quantidade_total)
    });
    mapa.set(chave, lista);
  }

  return mapa;
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
    throw new Error("Nenhuma fonte TTF compatível foi encontrada para gerar o PDF.");
  }

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 26,
    bufferPages: true,
    autoFirstPage: false
  });

  const buffers = [];
  doc.on("data", (chunk) => buffers.push(chunk));

  const fim = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  doc.registerFont("uniqstock-regular", fonteRegular);
  doc.registerFont("uniqstock-bold", fonteBold);

  const margin = 26;
  const startY = 36;
  const tableX = margin;
  const colunas = [
    { key: "codigo", label: "Código", width: 72, align: "left" },
    { key: "ferramenta", label: "Ferramenta", width: 176, align: "left" },
    { key: "categoria", label: "Categoria", width: 86, align: "left" },
    { key: "marca_modelo", label: "Marca / Modelo", width: 126, align: "left" },
    { key: "quantidade_total", label: "Qtd.", width: 40, align: "right" },
    { key: "localizacao", label: "Localização", width: 180, align: "left" },
    { key: "estado_inicial", label: "Estado", width: 118, align: "left" }
  ];
  const tableWidth = colunas.reduce((sum, col) => sum + col.width, 0);
  const rowHeight = 20;
  const headerRowY = 154;
  let pageWidth = 0;
  let pageHeight = 0;
  let footerY = 0;

  function drawHeader(paginaAtual, totalPaginas) {
    doc.save();
    doc.roundedRect(margin, startY, pageWidth - margin * 2, 60, 16).fill("#111827");
    doc.rect(margin, startY + 56, pageWidth - margin * 2, 4).fill("#d90404");

    doc.fillColor("#ffffff").font("uniqstock-bold").fontSize(22)
      .text("UniqStock | Relatório de Inventário", margin + 18, startY + 16, { lineBreak: false });

    doc.fillColor("#dbe7f3").font("uniqstock-regular").fontSize(9.5)
      .text(`Gerado em ${dataGeracao}`, pageWidth - margin - 200, startY + 21, {
        width: 180,
        align: "right",
        lineBreak: false
      });
    doc.restore();

    const cards = [
      { x: margin, title: "Itens no relatório", value: String(itens.length) },
      { x: margin + 180, title: "Categorias", value: String(totalCategorias) },
      { x: margin + 360, title: "Página", value: `${paginaAtual}/${totalPaginas}` }
    ];

    cards.forEach((card) => {
      doc.save();
      doc.roundedRect(card.x, 108, 166, 34, 12).fillAndStroke("#f8fafc", "#d7e0ea");
      doc.fillColor("#64748b").font("uniqstock-regular").fontSize(8.5)
        .text(card.title, card.x + 12, 117, { lineBreak: false });
      doc.fillColor("#0f172a").font("uniqstock-bold").fontSize(13.5)
        .text(card.value, card.x + 12, 128, { lineBreak: false });
      doc.restore();
    });
  }

  function drawTableHeader() {
    doc.save();
    doc.rect(tableX, headerRowY, tableWidth, rowHeight).fillAndStroke("#eef2f7", "#cbd5e1");
    let x = tableX;
    colunas.forEach((col) => {
      doc.fillColor("#0f172a").font("uniqstock-bold").fontSize(8.5)
        .text(col.label, x + 6, headerRowY + 6, { width: col.width - 12, align: "left" });
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
      doc.rect(tableX, y, tableWidth, rowHeight).fill("#fcfdff");
      doc.restore();
    }

    let x = tableX;
    colunas.forEach((col) => {
      const texto = sanitizeText(item[col.key] ?? "-");
      const paddingX = col.align === "right" ? 4 : 6;
      const fontSize = ["ferramenta", "marca_modelo"].includes(col.key) ? 8 : 8.5;
      doc.fillColor("#1f2937").font("uniqstock-regular").fontSize(fontSize)
        .text(texto, x + paddingX, y + 5.5, {
          width: col.width - (paddingX * 2),
          align: col.align,
          ellipsis: true,
          lineBreak: false
        });
      x += col.width;
    });

    doc.save();
    doc.strokeColor("#cbd5e1").lineWidth(0.7);
    doc.moveTo(tableX, y + rowHeight).lineTo(tableX + tableWidth, y + rowHeight).stroke();
    doc.restore();
  }

  function drawColumnLines(lastY) {
    let x = tableX;
    doc.save();
    doc.strokeColor("#cbd5e1").lineWidth(0.7);
    doc.rect(tableX, headerRowY, tableWidth, lastY - headerRowY).stroke();
    colunas.forEach((col) => {
      x += col.width;
      doc.moveTo(x, headerRowY).lineTo(x, lastY).stroke();
    });
    doc.restore();
  }

  const linhasPorPagina = 16;
  const totalPaginas = Math.max(1, Math.ceil(itens.length / linhasPorPagina));

  for (let pagina = 0; pagina < totalPaginas; pagina++) {
    doc.addPage();
    pageWidth = doc.page.width;
    pageHeight = doc.page.height;
    footerY = pageHeight - margin - 10;
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

    doc.fillColor("#64748b").font("uniqstock-regular").fontSize(8)
      .text("UniqStock | Software de Gestão de Estoque", margin, footerY, { lineBreak: false });
    doc.text(`Página ${pagina + 1} de ${totalPaginas}`, pageWidth - margin - 80, footerY, {
      width: 80,
      align: "right",
      lineBreak: false
    });
  }

  doc.end();
  return fim;
}

const PDF_IMPORT_COLUMNS = [
  { key: "codigo", label: "codigo", start: 26, end: 98 },
  { key: "ferramenta", label: "ferramenta", start: 98, end: 274 },
  { key: "categoria", label: "categoria", start: 274, end: 360 },
  { key: "marca_modelo", label: "marca / modelo", start: 360, end: 486 },
  { key: "quantidade_total", label: "qtd.", start: 486, end: 526 },
  { key: "localizacao", label: "localizacao", start: 526, end: 706 },
  { key: "estado_inicial", label: "estado", start: 706, end: 824 }
];

function normalizarTextoPdf(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extrairObjetosPdf(pdfBuffer) {
  const pdfTexto = pdfBuffer.toString("latin1");
  const objetos = new Map();
  const regexObjeto = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  let match;

  while ((match = regexObjeto.exec(pdfTexto)) !== null) {
    objetos.set(Number(match[1]), match[3]);
  }

  return objetos;
}

function extrairStreamPdfBuffer(objetoPdf) {
  const matchInicio = /stream\r?\n/.exec(objetoPdf);
  if (!matchInicio) return null;

  const inicio = matchInicio.index + matchInicio[0].length;
  const fim = objetoPdf.indexOf("endstream", inicio);
  if (fim < 0) return null;

  return Buffer.from(objetoPdf.slice(inicio, fim), "latin1");
}

function decodificarStreamPdf(objetoPdf) {
  const streamBuffer = extrairStreamPdfBuffer(objetoPdf);
  if (!streamBuffer) return null;

  try {
    if (objetoPdf.includes("/FlateDecode")) {
      return zlib.inflateSync(streamBuffer).toString("latin1");
    }
    return streamBuffer.toString("latin1");
  } catch (_) {
    return null;
  }
}

function parsePdfPageDescriptors(objetosPdf) {
  const paginas = [];

  for (const [id, corpo] of objetosPdf.entries()) {
    if (!/\/Type\s*\/Page\b/.test(corpo)) continue;

    const resourceMatch = corpo.match(/\/Resources\s+(\d+)\s+0\s+R/);
    const contentsRefs = [];
    const arrayMatch = corpo.match(/\/Contents\s*\[([\s\S]*?)\]/);

    if (arrayMatch) {
      for (const refMatch of arrayMatch[1].matchAll(/(\d+)\s+0\s+R/g)) {
        contentsRefs.push(Number(refMatch[1]));
      }
    } else {
      const contentMatch = corpo.match(/\/Contents\s+(\d+)\s+0\s+R/);
      if (contentMatch) {
        contentsRefs.push(Number(contentMatch[1]));
      }
    }

    if (contentsRefs.length === 0) continue;

    paginas.push({
      id,
      resourceRef: resourceMatch ? Number(resourceMatch[1]) : null,
      contentRefs: contentsRefs
    });
  }

  return paginas;
}

function decodePdfUnicodeHex(hex) {
  const limpo = String(hex || "").replace(/[^0-9a-f]/gi, "");
  let texto = "";

  for (let i = 0; i + 3 < limpo.length; i += 4) {
    const codeUnit = Number.parseInt(limpo.slice(i, i + 4), 16);
    if (!Number.isFinite(codeUnit)) continue;
    texto += String.fromCharCode(codeUnit);
  }

  return texto;
}

function incrementarHexPdf(hex, incremento) {
  const base = Number.parseInt(String(hex || "0"), 16);
  if (!Number.isFinite(base)) return String(hex || "").toUpperCase();
  return (base + incremento).toString(16).toUpperCase().padStart(String(hex || "").length, "0");
}

function parseToUnicodeCMap(cmapTexto) {
  const mapa = new Map();

  for (const bloco of cmapTexto.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of bloco[1].matchAll(/<([^>]+)>\s*<([^>]+)>/g)) {
      mapa.set(match[1].toUpperCase(), decodePdfUnicodeHex(match[2]));
    }
  }

  for (const bloco of cmapTexto.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const match of bloco[1].matchAll(/<([^>]+)>\s*<([^>]+)>\s*(\[[^\]]+\]|<[^>]+>)/g)) {
      const inicio = match[1].toUpperCase();
      const fim = match[2].toUpperCase();
      const destino = match[3];
      const total = Number.parseInt(fim, 16) - Number.parseInt(inicio, 16);
      if (!Number.isFinite(total) || total < 0) continue;

      if (destino.startsWith("[")) {
        const destinos = [...destino.matchAll(/<([^>]+)>/g)].map((item) => item[1]);
        for (let i = 0; i <= total && i < destinos.length; i++) {
          mapa.set(incrementarHexPdf(inicio, i), decodePdfUnicodeHex(destinos[i]));
        }
      } else {
        const destinoHex = destino.replace(/[<>]/g, "");
        const destinoBase = Number.parseInt(destinoHex, 16);
        if (!Number.isFinite(destinoBase)) continue;

        for (let i = 0; i <= total; i++) {
          mapa.set(
            incrementarHexPdf(inicio, i),
            String.fromCharCode(destinoBase + i)
          );
        }
      }
    }
  }

  return mapa;
}

function decodePdfHexFallback(hex) {
  const limpo = String(hex || "").replace(/[^0-9a-f]/gi, "");
  if (!limpo) return "";

  const buffer = Buffer.from(limpo, "hex");
  const utf8 = buffer.toString("utf8");
  return utf8.includes("\uFFFD") ? buffer.toString("latin1") : utf8;
}

function decodePdfHexText(hex, unicodeMap) {
  const limpo = String(hex || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (!limpo) return "";

  if (unicodeMap && unicodeMap.size > 0) {
    const tamanhos = [...new Set([...unicodeMap.keys()].map((key) => key.length))].sort((a, b) => b - a);
    let cursor = 0;
    let texto = "";

    while (cursor < limpo.length) {
      let encontrou = false;

      for (const tamanho of tamanhos) {
        const trecho = limpo.slice(cursor, cursor + tamanho);
        if (trecho.length !== tamanho) continue;
        if (!unicodeMap.has(trecho)) continue;
        texto += unicodeMap.get(trecho);
        cursor += tamanho;
        encontrou = true;
        break;
      }

      if (!encontrou) {
        texto += decodePdfHexFallback(limpo.slice(cursor, cursor + 2));
        cursor += 2;
      }
    }

    return texto;
  }

  return decodePdfHexFallback(limpo);
}

function decodePdfLiteralText(texto) {
  return String(texto || "")
    .replace(/\\([\\()])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f");
}

function extrairTextoDoBlocoPdf(bloco, unicodeMap) {
  const partes = [];

  for (const match of bloco.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    const arrayTexto = match[1];
    let trecho = "";

    for (const item of arrayTexto.matchAll(/<([^>]+)>|\(((?:\\.|[^\\)])*)\)/g)) {
      if (item[1]) trecho += decodePdfHexText(item[1], unicodeMap);
      else if (item[2]) trecho += decodePdfLiteralText(item[2]);
    }

    if (trecho) partes.push(trecho);
  }

  if (partes.length === 0) {
    for (const match of bloco.matchAll(/<([^>]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (match[1]) partes.push(decodePdfHexText(match[1], unicodeMap));
      else if (match[2]) partes.push(decodePdfLiteralText(match[2]));
    }
  }

  return partes.join(" ").replace(/\s+/g, " ").trim();
}

function construirMapeamentoFontesPdf(objetosPdf, resourceRef) {
  const mapeamento = new Map();
  if (!resourceRef) return mapeamento;

  const recurso = objetosPdf.get(resourceRef);
  if (!recurso) return mapeamento;

  for (const match of recurso.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) {
    const alias = match[1];
    const fontRef = Number(match[2]);
    const fontObj = objetosPdf.get(fontRef);
    if (!fontObj) continue;

    const toUnicodeMatch = fontObj.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!toUnicodeMatch) continue;

    const cmapObj = objetosPdf.get(Number(toUnicodeMatch[1]));
    if (!cmapObj) continue;

    const cmapTexto = decodificarStreamPdf(cmapObj);
    if (!cmapTexto) continue;

    mapeamento.set(alias, parseToUnicodeCMap(cmapTexto));
  }

  return mapeamento;
}

function extrairItensTextoPdf(conteudoPdf, fontesPdf) {
  const itens = [];

  for (const blocoMatch of conteudoPdf.matchAll(/BT([\s\S]*?)ET/g)) {
    const bloco = blocoMatch[1];
    const tmMatches = [...bloco.matchAll(/[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g)];
    if (tmMatches.length === 0) continue;

    const tm = tmMatches[tmMatches.length - 1];
    const x = Number(tm[1]);
    const y = Number(tm[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const fontMatches = [...bloco.matchAll(/\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf/g)];
    const aliasFonte = fontMatches.length > 0 ? fontMatches[fontMatches.length - 1][1] : "";
    const texto = extrairTextoDoBlocoPdf(bloco, fontesPdf.get(aliasFonte));

    if (!texto) continue;

    itens.push({ x, y, text: texto });
  }

  return itens;
}

function agruparItensPdfPorLinha(itens) {
  const ordenados = [...itens].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });

  const grupos = [];

  for (const item of ordenados) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && Math.abs(ultimo.y - item.y) <= 2.5) {
      ultimo.items.push(item);
      continue;
    }

    grupos.push({ y: item.y, items: [item] });
  }

  grupos.forEach((grupo) => {
    grupo.items.sort((a, b) => a.x - b.x);
  });

  return grupos;
}

function linhaPdfEhCabecalho(grupo) {
  const textos = grupo.items.map((item) => normalizarTextoPdf(item.text));
  const labels = PDF_IMPORT_COLUMNS.map((col) => col.label);
  const hits = labels.filter((label) => textos.includes(label)).length;
  return hits >= 4 && textos.includes("codigo") && textos.includes("ferramenta");
}

function encontrarColunaPdfPorPosicao(x) {
  const ordenadas = PDF_IMPORT_COLUMNS;
  for (let i = 0; i < ordenadas.length; i++) {
    const atual = ordenadas[i];
    const proxima = ordenadas[i + 1];
    const limiteEsquerdo = atual.start - 6;
    const limiteDireito = proxima ? proxima.start - 6 : atual.end + 12;

    if (x >= limiteEsquerdo && x < limiteDireito) {
      return atual;
    }
  }

  return null;
}

function construirLinhaImportacaoPdf(grupo) {
  const linha = {
    codigo: "",
    ferramenta: "",
    categoria: "",
    marca_modelo: "",
    quantidade_total: "",
    localizacao: "",
    estado_inicial: ""
  };

  grupo.items.forEach((item) => {
    const coluna = encontrarColunaPdfPorPosicao(item.x);
    if (!coluna) return;

    const valorAtual = normalizeText(linha[coluna.key]);
    linha[coluna.key] = valorAtual ? `${valorAtual} ${item.text}` : item.text;
  });

  Object.keys(linha).forEach((chave) => {
    linha[chave] = normalizeText(linha[chave]);
  });

  return linha;
}

function parsePdfParaLinhas(pdfBuffer) {
  const objetosPdf = extrairObjetosPdf(pdfBuffer);
  const paginas = parsePdfPageDescriptors(objetosPdf);
  const linhas = [];

  paginas.forEach((pagina) => {
    const fontesPdf = construirMapeamentoFontesPdf(objetosPdf, pagina.resourceRef);
    const itensPagina = [];

    pagina.contentRefs.forEach((contentRef) => {
      const objetoConteudo = objetosPdf.get(contentRef);
      if (!objetoConteudo) return;

      const conteudoPdf = decodificarStreamPdf(objetoConteudo);
      if (!conteudoPdf) return;

      itensPagina.push(...extrairItensTextoPdf(conteudoPdf, fontesPdf));
    });

    const grupos = agruparItensPdfPorLinha(itensPagina);
    const header = grupos.find((grupo) => linhaPdfEhCabecalho(grupo));
    if (!header) return;

    grupos.forEach((grupo) => {
      if (grupo === header) return;
      if (grupo.y >= header.y - 3) return;
      if (grupo.y < 45) return;

      const linha = construirLinhaImportacaoPdf(grupo);
      const preenchidos = Object.values(linha).filter((valor) => normalizeText(valor) !== "").length;

      if (!linha.ferramenta && !linha.codigo) return;
      if (preenchidos < 2) return;

      linhas.push(linha);
    });
  });

  return linhas;
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
    linha.estado_inicial
  ];

  return campos.some((campo) => normalizeText(campo) !== "");
}

function criarErroImportacaoTransacional(relatorio) {
  const erro = criarErroHttp(400, "Nenhuma alteração foi aplicada. Verifique o relatório de erros.");
  erro.relatorio = {
    ...relatorio,
    total_importado: 0,
    total_atualizado: 0,
    transacao_revertida: true
  };
  return erro;
}

async function importarLinhasNoBanco(linhas, executor = null) {
  if (!executor) {
    return executarTransacaoExclusiva(async (trx) => importarLinhasNoBanco(linhas, trx));
  }

  const relatorio = {
    total_recebido: Array.isArray(linhas) ? linhas.length : 0,
    total_importado: 0,
    total_atualizado: 0,
    total_ignorado: 0,
    total_erros: 0,
    ignorados: [],
    erros: []
  };
  const banco = criarExecutorBanco(executor);
  const itensPorChaveConteudo = await carregarItensPorChaveConteudo(banco);

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
    const categoriaFinal = categoriaPadronizada(linha.categoria, nomeFerramenta);
    const marcaModelo = normalizeText(linha.marca_modelo);
    const localizacao = normalizeText(linha.localizacao);
    const estadoInicial = normalizeText(linha.estado_inicial);

    if (!nomeFerramenta) {
      relatorio.total_ignorado++;
      relatorio.ignorados.push({
        linha: numeroLinha,
        motivo: "Campo ferramenta/nome ausente"
      });
      continue;
    }

    let quantidadeImportada = 1;
    try {
      quantidadeImportada = parseQuantidadeImportacao(linha.quantidade_total);
    } catch (erro) {
      relatorio.total_erros++;
      relatorio.erros.push({
        linha: numeroLinha,
        mensagem: String(erro?.message || "Quantidade inválida")
      });
      continue;
    }

    const chaveConteudo = criarChaveConteudoItem({
      ferramenta: nomeFerramenta,
      categoria: categoriaFinal,
      marca_modelo: marcaModelo,
      localizacao
    });
    const itensCorrespondentes = itensPorChaveConteudo.get(chaveConteudo) || [];

    if (itensCorrespondentes.length > 1) {
      relatorio.total_erros++;
      relatorio.erros.push({
        linha: numeroLinha,
        mensagem: "Já existem vários itens com esse conteúdo no sistema. Revise os cadastros antes de importar novas quantidades."
      });
      continue;
    }

    if (itensCorrespondentes.length === 1) {
      const itemExistente = itensCorrespondentes[0];
      const quantidadeFinal = parseNumero(itemExistente.quantidade_total) + quantidadeImportada;

      try {
        await banco.runQuery(
          `UPDATE itens
           SET quantidade_total = ?
           WHERE id = ?`,
          [quantidadeFinal, itemExistente.id]
        );

        itemExistente.quantidade_total = quantidadeFinal;
        relatorio.total_atualizado++;
      } catch (erro) {
        relatorio.total_erros++;
        relatorio.erros.push({
          linha: numeroLinha,
          codigo: itemExistente.codigo,
          mensagem: String(erro?.message || "Erro ao atualizar quantidade do item")
        });
      }

      continue;
    }

    try {
      const codigoFinal = await gerarCodigoAutomatico("", banco);

      const result = await banco.runQuery(
        `INSERT INTO itens (
          codigo,
          ferramenta,
          categoria,
          marca_modelo,
          quantidade_total,
          localizacao,
          estado_inicial
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoFinal,
          nomeFerramenta,
          categoriaFinal,
          marcaModelo,
          quantidadeImportada,
          localizacao,
          estadoInicial
        ]
      );

      itensPorChaveConteudo.set(chaveConteudo, [{
        id: result.id,
        codigo: codigoFinal,
        quantidade_total: quantidadeImportada
      }]);
      relatorio.total_importado++;
    } catch (erro) {
      relatorio.total_erros++;
      relatorio.erros.push({
        linha: numeroLinha,
        mensagem: String(erro?.message || "Erro ao importar linha")
      });
    }
  }

  if (relatorio.total_erros > 0) {
    throw criarErroImportacaoTransacional(relatorio);
  }

  return relatorio;
}

// =========================
// CRIAÇÃO DAS TABELAS
// =========================
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON`);

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      perfil TEXT,
      sessao_versao INTEGER DEFAULT 0
    )
  `);

  db.all(`PRAGMA table_info(usuarios)`, (err, cols) => {
    if (err) {
      console.error("Erro ao verificar colunas de usuarios:", err.message);
      return;
    }

    const colunas = new Set((cols || []).map((c) => c.name));
    if (!colunas.has("sessao_versao")) {
      db.run(
        `ALTER TABLE usuarios ADD COLUMN sessao_versao INTEGER DEFAULT 0`,
        (alterErr) => {
          if (alterErr) {
            console.error("Erro ao criar coluna sessao_versao:", alterErr.message);
          }
        }
      );
    }
  });

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

  db.all(`PRAGMA table_info(permissoes_usuarios)`, (err, cols) => {
    if (err) {
      console.error("Erro ao verificar colunas de permissoes_usuarios:", err.message);
      return;
    }

    const colunas = new Set((cols || []).map((c) => c.name));
    const migracoes = [
      ["criar_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN criar_itens INTEGER DEFAULT 0"],
      ["editar_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN editar_itens INTEGER DEFAULT 0"],
      ["excluir_itens", "ALTER TABLE permissoes_usuarios ADD COLUMN excluir_itens INTEGER DEFAULT 0"]
    ];

    migracoes.forEach(([nome, sql]) => {
      if (!colunas.has(nome)) {
        db.run(sql, (alterErr) => {
          if (alterErr) {
            console.error(`Erro ao criar coluna ${nome}:`, alterErr.message);
          }
        });
      }
    });

    db.run(`
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
  });

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
      ('estoque_baixo_limite', '2'),
      ('licenca_ativa', '0'),
      ('licenca_chave', ''),
      ('licenca_cliente', ''),
      ('licenca_expira_em', ''),
      ('licenca_ativada_em', ''),
      ('licenca_provedor', ''),
      ('licenca_cache_cliente', ''),
      ('licenca_cache_expira_em', ''),
      ('licenca_cache_machine_code', ''),
      ('licenca_cache_validada_em', '')`
  );

  db.get(`SELECT COUNT(*) AS total FROM usuarios`, async (err) => {
    if (err) {
      console.error("Erro ao preparar bootstrap de usuários:", err.message);
      return;
    }

    try {
      await migrarSenhasTextoPuro();
      await bootstrapAdminInicialSeguro();
    } catch (bootstrapErr) {
      console.error("Erro ao inicializar usuários:", bootstrapErr.message);
    }
  });
});

setTimeout(() => {
  normalizarCategoriasExistentes().catch((erro) => {
    console.error("Erro ao normalizar categorias existentes:", erro.message);
  });
}, 300);

// =========================
// API: STATUS
// =========================
app.get("/api/status", (req, res) => {
  res.json({ ok: true, mensagem: "Servidor funcionando" });
});

app.get("/api/app/version", (req, res) => {
  res.json({ ok: true, version: packageJson.version || "0.0.0" });
});

function normalizarReleaseAtualizacao(data = {}) {
  const version = normalizeText(data.version);
  const urlInstaller = normalizeText(data.url_installer || data.url || data.download_url);
  const sha256 = normalizeText(data.sha256).toLowerCase() || null;
  const notes = typeof data.notes === "string" ? data.notes : "";
  const publishedAt = normalizeText(data.published_at || data.publishedAt || "");

  if (!version) {
    return null;
  }

  return {
    version,
    url_installer: urlInstaller,
    sha256,
    mandatory: Boolean(data.mandatory),
    notes,
    published_at: publishedAt || null,
    active: data.active !== false
  };
}

function urlAtualizacaoEhSegura(urlTexto) {
  const texto = normalizeText(urlTexto);
  if (!texto) return false;

  try {
    const url = new URL(texto);
    const protocolo = url.protocol.toLowerCase();
    const host = url.host.toLowerCase();
    const isLoopback = host.startsWith("127.0.0.1") || host.startsWith("localhost");

    if (!["https:", "http:"].includes(protocolo)) {
      return false;
    }

    if (protocolo === "http:" && !isLoopback) {
      return false;
    }

    if (url.username || url.password) {
      return false;
    }

    if (UPDATE_ALLOWED_HOSTS.length > 0 && !UPDATE_ALLOWED_HOSTS.includes(host)) {
      return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

function nomeArquivoAtualizacaoSeguro(release, urlTexto) {
  try {
    const url = new URL(urlTexto);
    const nomeDaUrl = path.basename(url.pathname || "");
    const nomeBase = normalizeText(nomeDaUrl) || `UniqStock-Setup-${release.version}.exe`;
    return Array.from(nomeBase, (char) => {
      const code = char.charCodeAt(0);
      return /[<>:"/\\|?*]/.test(char) || code < 32 ? "_" : char;
    }).join("");
  } catch (_) {
    return `UniqStock-Setup-${release.version}.exe`;
  }
}

async function obterReleaseAtualizacaoApi(version = "") {
  const endpoint = version
    ? `/api/releases/${encodeURIComponent(version)}`
    : "/api/releases/latest";
  const resultado = await requisicaoApiComercialJson("GET", endpoint);

  if (!resultado.ok) {
    return {
      ok: false,
      status: resultado.status || 503,
      error: resultado.error || "Falha ao consultar releases",
      detalhe: resultado.detalhe || ""
    };
  }

  const bruto = resultado.data?.release || resultado.data?.latest || resultado.data;
  const release = normalizarReleaseAtualizacao(bruto);
  if (!release || release.active === false) {
    return { ok: false, status: 404, error: "Nenhuma release ativa encontrada" };
  }

  return { ok: true, release, provider: "api" };
}

async function obterReleaseAtualizacaoSupabase(version = "") {
  if (!USE_LEGACY_SUPABASE_LICENSE || !supabase) {
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

  const release = normalizarReleaseAtualizacao(data || {});
  if (!release || release.active === false) {
    return { ok: false, status: 404, error: "Nenhuma release ativa encontrada" };
  }

  return { ok: true, release, provider: "supabase-legacy" };
}

async function obterReleaseAtualizacao(version = "") {
  if (USE_COMMERCIAL_API) {
    return obterReleaseAtualizacaoApi(version);
  }

  if (USE_LEGACY_SUPABASE_LICENSE) {
    return obterReleaseAtualizacaoSupabase(version);
  }

  return { ok: false, status: 503, error: "Atualização remota indisponível" };
}

async function baixarReleaseVerificada(release) {
  const urlInstaller = normalizeText(release?.url_installer);
  if (!urlInstaller) {
    throw criarErroHttp(400, "Release sem URL de instalador");
  }

  if (!urlAtualizacaoEhSegura(urlInstaller)) {
    throw criarErroHttp(400, "URL do instalador bloqueada por política de segurança");
  }

  const shaEsperado = normalizeText(release?.sha256).toLowerCase();
  if (REQUIRE_SIGNED_INSTALLER && !shaEsperado) {
    throw criarErroHttp(400, "Release sem SHA-256 publicado. Download bloqueado.");
  }

  let response;
  try {
    response = await fetch(urlInstaller);
  } catch (e) {
    throw criarErroHttp(503, `Falha ao baixar instalador: ${e.message}`);
  }

  if (!response.ok || !response.body) {
    throw criarErroHttp(502, `Download do instalador falhou (${response.status})`);
  }

  const nomeArquivo = nomeArquivoAtualizacaoSeguro(release, urlInstaller);
  const caminhoTemp = path.join(UPDATES_DIR, `${Date.now()}-${crypto.randomUUID()}-${nomeArquivo}`);
  const arquivo = fs.createWriteStream(caminhoTemp);
  const hash = crypto.createHash("sha256");
  const streamLeitura = Readable.fromWeb(response.body);

  await new Promise((resolve, reject) => {
    streamLeitura.on("data", (chunk) => hash.update(chunk));
    streamLeitura.on("error", reject);
    arquivo.on("error", reject);
    arquivo.on("finish", resolve);
    streamLeitura.pipe(arquivo);
  });

  const shaCalculado = hash.digest("hex").toLowerCase();
  if (shaEsperado && shaCalculado !== shaEsperado) {
    deletarArquivoSeExistir(caminhoTemp);
    throw criarErroHttp(502, "Integridade do instalador inválida (SHA-256 divergente)");
  }

  const stat = await fs.promises.stat(caminhoTemp);
  return {
    path: caminhoTemp,
    fileName: nomeArquivo,
    sha256: shaCalculado,
    sizeBytes: stat.size
  };
}

app.get("/api/app/update-check", requireAdmin, async (req, res) => {
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
    const hasSignedInstaller = Boolean(normalizeText(data.sha256));
    const downloadBlockedReason = !normalizeText(data.url_installer)
      ? "Release sem URL de instalador"
      : (REQUIRE_SIGNED_INSTALLER && !hasSignedInstaller)
        ? "Release sem SHA-256 publicado"
        : (!urlAtualizacaoEhSegura(data.url_installer))
          ? "URL do instalador bloqueada por política de segurança"
          : "";

    return res.json({
      ok: true,
      current_version: current,
      update_available: updateAvailable,
      latest: {
        version: latestVersion,
        url_installer: null,
        download_url: downloadBlockedReason ? null : `/api/app/update-download?version=${encodeURIComponent(latestVersion)}`,
        download_blocked_reason: downloadBlockedReason || null,
        sha256: data.sha256 || null,
        mandatory: Boolean(data.mandatory),
        notes: data.notes || "",
        published_at: data.published_at || null,
        provider: releaseResult.provider || "local"
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/app/update-download", requireAdmin, async (req, res) => {
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
    const arquivo = await baixarReleaseVerificada(release);
    await registrarAuditoria(req, "BAIXAR_ATUALIZACAO", "release", null, {
      version: release.version,
      sha256: arquivo.sha256,
      bytes: arquivo.sizeBytes
    });

    return res.download(arquivo.path, arquivo.fileName, () => {
      deletarArquivoSeExistir(arquivo.path);
    });
  } catch (e) {
    if (Number(e?.statusCode)) {
      return res.status(e.statusCode).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/licenca/status", async (req, res) => {
  const status = await obterStatusLicenca();
  res.json({
    ok: true,
    modo_remoto: Boolean(status?.provedor && status.provedor !== "local"),
    ...status
  });
});

app.get("/api/licenca/maquina", async (req, res) => {
  res.json({ ok: true, codigo_maquina: gerarCodigoMaquina() });
});

app.post("/api/licenca/ativar", async (req, res) => {
  try {
    const licencaJaConfigurada = normalizeText(await obterConfigValor("licenca_chave", "")) !== "";
    if (licencaJaConfigurada) {
      const user = await obterUsuarioSessaoAtual(req);
      if (!user || user.perfil !== "admin") {
        destruirSessaoSilenciosamente(req);
        return res.status(403).json({ error: "Apenas administradores podem alterar a licença após a ativação inicial" });
      }
    }

    const chave = normalizeText(req.body?.chave);
    if (!chave) {
      return res.status(400).json({ error: "Informe a chave de ativação" });
    }

    const resultado = USE_COMMERCIAL_API
      ? await ativarLicencaApi(chave)
      : (USE_LEGACY_SUPABASE_LICENSE
          ? await ativarLicencaSupabase(chave)
          : await ativarLicencaLocal(chave));

    if (!resultado.ok) {
      return res.status(resultado.status || 400).json({ error: resultado.error });
    }

    invalidarCacheLicenca();
    await registrarAuditoria(req, "ATIVAR_LICENCA", "licenca", null, {
      cliente: resultado.cliente,
      expira_em: resultado.expira_em,
      modo_remoto: Boolean(resultado?.provedor && resultado.provedor !== "local"),
      provedor: resultado.provedor || "local"
    });
    return res.json({
      ok: true,
      cliente: resultado.cliente,
      expira_em: resultado.expira_em,
      provedor: resultado.provedor || "local"
    });
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
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0)`,
      [result.id]
    );

    await registrarAuditoria(req, "CRIAR_USUARIO", "usuario", result.id, {
      usuario,
      perfil: "operador",
      origem: "cadastro_admin"
    });

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
  const ip = normalizeText(req.ip || req.socket?.remoteAddress || "desconhecido");

  if (!usuario || !senha) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
  }

  try {
    const bloqueioMs = obterBloqueioLogin(usuario, ip);
    if (bloqueioMs > 0) {
      return res.status(429).json({
        error: `Muitas tentativas. Tente novamente em ${Math.ceil(bloqueioMs / 1000)} segundo(s).`
      });
    }

    const user = await getQuery(
      `SELECT * FROM usuarios WHERE usuario = ?`,
      [usuario]
    );

    let senhaOk = false;

    if (user && typeof user.senha === "string") {
      if (user.senha.startsWith("$2")) {
        senhaOk = await bcrypt.compare(senha, user.senha);
      } else if (user.senha === senha) {
        const hashMigrado = await bcrypt.hash(senha, 10);
        await runQuery(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hashMigrado, user.id]);
        senhaOk = true;
      }
    }

    if (!user || !senhaOk) {
      registrarFalhaLogin(usuario, ip);
      await registrarAuditoria(req, "LOGIN_FALHA", "auth", null, {
        usuario_tentativa: usuario,
        motivo: user ? "senha_incorreta" : "usuario_nao_encontrado",
        ip
      }, usuario || "desconhecido");
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    limparTentativasLoginFalha(usuario, ip);

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    req.session.user = {
      usuario: user.usuario,
      perfil: user.perfil,
      sessao_versao: Number(user.sessao_versao || 0)
    };
    await registrarAuditoria(req, "LOGIN_SUCESSO", "auth", user.id, {
      usuario: user.usuario,
      perfil: user.perfil,
      ip
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
app.get("/api/me", async (req, res) => {
  try {
    const user = await obterUsuarioSessaoAtual(req);
    if (!user) {
      destruirSessaoSilenciosamente(req);
      return res.status(401).json({ error: "Não autenticado" });
    }
    return res.json({ ok: true, user: { usuario: user.usuario, perfil: user.perfil } });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session?.destroy(() => {
    res.clearCookie("uniqstock.sid");
    res.json({ ok: true });
  });
});

async function requireAuth(req, res, next) {
  try {
    const user = await obterUsuarioSessaoAtual(req);
    if (!user) {
      destruirSessaoSilenciosamente(req);
      return res.status(401).json({ error: "Não autenticado" });
    }
    req.authUser = user;
    return next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await obterUsuarioSessaoAtual(req);
    if (!user) {
      destruirSessaoSilenciosamente(req);
      return res.status(401).json({ error: "Não autenticado" });
    }
    if (user.perfil !== "admin") {
      return res.status(403).json({ error: "Acesso negado" });
    }
    req.authUser = user;
    return next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getUserPerms(usuario) {
  const user = await getQuery(`SELECT id, perfil FROM usuarios WHERE usuario = ?`, [usuario]);
  if (!user) return null;
  const perms = await getQuery(`SELECT * FROM permissoes_usuarios WHERE user_id = ?`, [user.id]);
  if (!perms) {
    console.warn(`Permissões ausentes para o usuário ${user.usuario} (${user.id})`);
    return null;
  }
  return { user, perms };
}

app.get("/api/minhas-permissoes", requireAuth, async (req, res) => {
  try {
    const info = await getUserPerms(req.authUser.usuario);
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
    try {
      const user = await obterUsuarioSessaoAtual(req);
      if (!user) {
        destruirSessaoSilenciosamente(req);
        return res.status(401).json({ error: "Não autenticado" });
      }
      req.authUser = user;
      const info = await getUserPerms(user.usuario);
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
    await runQuery(
      `UPDATE usuarios
       SET senha = ?, sessao_versao = COALESCE(sessao_versao, 0) + 1
       WHERE usuario = ?`,
      [hash, usuarioSessao]
    );
    await registrarAuditoria(req, "ALTERAR_SENHA", "usuario", user.id, {
      usuario: usuarioSessao,
      sessoes_invalidadas: true
    });
    req.session?.destroy(() => {
      res.clearCookie("uniqstock.sid");
      res.json({ ok: true, relogin: true });
    });
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
    await runQuery(
      `UPDATE usuarios
       SET senha = ?, sessao_versao = COALESCE(sessao_versao, 0) + 1
       WHERE id = ?`,
      [hash, id]
    );
    await registrarAuditoria(req, "RESETAR_SENHA", "usuario", id, {
      usuario: user.usuario,
      sessoes_invalidadas: true
    });
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
        user_id, ver_dashboard, ver_inventario, criar_editar_itens, criar_itens, editar_itens, excluir_itens, ver_etiquetas,
        usar_scanner, ver_movimentacoes, registrar_movimentacao, importar_exportar, gerenciar_usuarios
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, 1,
        1, 1, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0
      ]
    );

    await registrarAuditoria(req, "CRIAR_USUARIO", "usuario", id, {
      usuario,
      perfil: perfil === "admin" ? "admin" : "operador"
    });

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
    await registrarAuditoria(req, "EXCLUIR_USUARIO", "usuario", id, {
      usuario: user.usuario,
      perfil: user.perfil
    });
    await runQuery(`DELETE FROM permissoes_usuarios WHERE user_id = ?`, [id]);
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
      return res.status(400).json({ error: "Nenhuma permissão enviada" });
    }
    const setClause = Object.keys(valores).map(k => `${k} = ?`).join(", ");
    const params = [...Object.values(valores), id];
    await runQuery(`UPDATE permissoes_usuarios SET ${setClause} WHERE user_id = ?`, params);
    await registrarAuditoria(req, "ATUALIZAR_PERMISSOES", "usuario", id, {
      alteracoes: valores
    });
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
    const ultimoBackup = await obterUltimoBackupDisponivel();
    res.json({
      ok: true,
      backup_auto_habilitado: Number(habilitado) === 1,
      backup_auto_horario: horario,
      backup_reter_dias: Math.max(1, Number(reterDias) || 15),
      ultimo_backup: ultimoBackup
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      return res.status(400).json({ error: "Horário inválido. Use HH:MM." });
    }

    const [hh, mm] = horario.split(":").map((v) => Number(v));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return res.status(400).json({ error: "Horário inválido." });
    }

    await definirConfigValor("backup_auto_habilitado", String(habilitado));
    await definirConfigValor("backup_auto_horario", horario);
    await definirConfigValor("backup_reter_dias", String(reterDias));
    await registrarAuditoria(req, "ATUALIZAR_CONFIG_BACKUP", "configuracao", null, {
      backup_auto_habilitado: Boolean(habilitado),
      backup_auto_horario: horario,
      backup_reter_dias: reterDias
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/configuracoes/estoque", requireAdmin, async (req, res) => {
  try {
    const limite = Math.max(1, Number(req.body?.estoque_baixo_limite) || 2);
    await definirConfigValor("estoque_baixo_limite", String(limite));
    await registrarAuditoria(req, "ATUALIZAR_CONFIG_ESTOQUE", "configuracao", null, {
      estoque_baixo_limite: limite
    });
    res.json({ ok: true, estoque_baixo_limite: limite });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/configuracoes/backup/executar", requireAdmin, async (req, res) => {
  try {
    const backup = await executarBackupAutomatico();
    await registrarAuditoria(req, "EXECUTAR_BACKUP_MANUAL", "configuracao", null, {
      tipo: "backup_manual",
      file_name: backup.file_name,
      size_bytes: backup.size_bytes,
      integrity_check: backup.integrity_check
    });
    res.json({ ok: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// API: ITENS
// =========================
app.get("/api/itens", requirePerm("ver_inventario"), async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        i.id,
        i.codigo,
        i.ferramenta,
        i.categoria,
        i.marca_modelo,
        i.quantidade_total,
        i.localizacao,
        i.estado_inicial,
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

app.get("/api/items", requirePerm("ver_inventario"), async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        i.id,
        i.codigo,
        i.ferramenta,
        i.categoria,
        i.marca_modelo,
        i.quantidade_total,
        i.localizacao,
        i.estado_inicial,
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
      codigo,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial
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
        estado_inicial
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseQuantidadeTotalItem(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial)
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

    if (Number(e?.statusCode) === 400) {
      return res.status(400).json({ error: e.message });
    }

    res.status(500).json({ error: e.message });
  }
});

app.post("/api/items", requirePerm("criar_itens"), async (req, res) => {
  try {
    const {
      codigo,
      nome,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial
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
        estado_inicial
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseQuantidadeTotalItem(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial)
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

    if (Number(e?.statusCode) === 400) {
      return res.status(400).json({ error: e.message });
    }

    res.status(500).json({ error: e.message });
  }
});

app.put("/api/itens/:id", requirePerm("editar_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT * FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const {
      codigo,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial
    } = req.body || {};

    const nomeFerramenta = normalizeText(ferramenta);
    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta é obrigatório" });
    }

    const codigoFinal = await validarCodigoDisponivelParaItem(codigo || itemAtual.codigo, id);

    await runQuery(
      `UPDATE itens
       SET codigo = ?, ferramenta = ?, categoria = ?, marca_modelo = ?, quantidade_total = ?,
           localizacao = ?, estado_inicial = ?
       WHERE id = ?`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseQuantidadeTotalItem(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
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
      return res.status(400).json({ error: "Já existe um item com esse código." });
    }
    if (Number(e?.statusCode) === 400) {
      return res.status(400).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.put("/api/items/:id", requirePerm("editar_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT * FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const {
      codigo,
      nome,
      ferramenta,
      categoria,
      marca_modelo,
      quantidade_total,
      localizacao,
      estado_inicial
    } = req.body || {};

    const nomeFerramenta = normalizeText(ferramenta || nome);
    if (!nomeFerramenta) {
      return res.status(400).json({ error: "O campo ferramenta/nome é obrigatório" });
    }

    const codigoFinal = await validarCodigoDisponivelParaItem(codigo || itemAtual.codigo, id);

    await runQuery(
      `UPDATE itens
       SET codigo = ?, ferramenta = ?, categoria = ?, marca_modelo = ?, quantidade_total = ?,
           localizacao = ?, estado_inicial = ?
       WHERE id = ?`,
      [
        codigoFinal,
        nomeFerramenta,
        categoriaPadronizada(categoria, nomeFerramenta),
        normalizeText(marca_modelo),
        parseQuantidadeTotalItem(quantidade_total),
        normalizeText(localizacao),
        normalizeText(estado_inicial),
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
      return res.status(400).json({ error: "Já existe um item com esse código." });
    }
    if (Number(e?.statusCode) === 400) {
      return res.status(400).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/api/itens/:id", requirePerm("excluir_itens"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const itemAtual = await getQuery(`SELECT id, codigo, ferramenta FROM itens WHERE id = ?`, [id]);

    if (!itemAtual) {
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const movimentacoes = await getQuery(
      `SELECT COUNT(*) AS total FROM movimentacoes WHERE item_id = ?`,
      [id]
    );

    if (Number(movimentacoes?.total || 0) > 0) {
      return res.status(400).json({
        error: "Não é possível excluir itens com histórico de movimentações."
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
      return res.status(404).json({ error: "Item não encontrado" });
    }

    const movimentacoes = await getQuery(
      `SELECT COUNT(*) AS total FROM movimentacoes WHERE item_id = ?`,
      [id]
    );

    if (Number(movimentacoes?.total || 0) > 0) {
      return res.status(400).json({
        error: "Não é possível excluir itens com histórico de movimentações."
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
// API: MOVIMENTAÇÕES
// =========================
app.get("/api/movimentacoes", requirePerm("ver_movimentacoes"), async (req, res) => {
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

app.get("/api/movements", requirePerm("ver_movimentacoes"), async (req, res) => {
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

async function processarRegistroMovimentacao(req, res) {
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
    const result = await registrarMovimentacaoAtomica({
      itemId: Number(item_id),
      tipo,
      quantidade: qtd,
      obra,
      funcionario,
      observacao
    });

    await registrarAuditoria(req, "REGISTRAR_MOVIMENTACAO", "movimentacao", result.id, {
      item_id: Number(item_id),
      tipo,
      quantidade: qtd
    });

    res.json({ ok: true });
  } catch (e) {
    if (Number(e?.statusCode)) {
      return res.status(e.statusCode).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
}

app.post("/api/movimentacoes", requirePerm("registrar_movimentacao"), processarRegistroMovimentacao);

app.post("/api/movements", requirePerm("registrar_movimentacao"), processarRegistroMovimentacao);

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
  const codigo = normalizarCodigo(
    normalizeText(req.params.codigo).replace(/^(PRZ|UNIQ)-/i, "")
  );

  try {
    const itemComCodigo = await buscarItemPorCodigoNormalizado(codigo);

    if (!itemComCodigo) {
      return res.status(404).json({ error: "Ferramenta não encontrada" });
    }

    const item = await getQuery(
      `SELECT * FROM itens WHERE id = ?`,
      [itemComCodigo.id]
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
// IMPORTAR CSV / XLSX / XLS / XML / PDF
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
    } else if (extensao === ".pdf") {
      const pdfBruto = fs.readFileSync(req.file.path);
      linhas = parsePdfParaLinhas(pdfBruto);
      if (!linhas.length) {
        deletarArquivoSeExistir(req.file.path);
        return res.status(400).json({
          error: "PDF sem tabela textual importável. Use um PDF textual, preferencialmente exportado pelo UniqStock."
        });
      }
    } else {
      deletarArquivoSeExistir(req.file.path);
      return res.status(400).json({
        error: "Formato não suportado. Use CSV, XLSX, XLS, XML ou PDF."
      });
    }

    const relatorio = await importarLinhasNoBanco(linhas);
    await registrarAuditoria(req, "IMPORTAR_ITENS", "item", null, {
      arquivo: req.file.originalname,
      extensao,
      total_recebido: relatorio.total_recebido,
      total_importado: relatorio.total_importado,
      total_atualizado: relatorio.total_atualizado,
      total_ignorado: relatorio.total_ignorado,
      total_erros: relatorio.total_erros
    });

    deletarArquivoSeExistir(req.file.path);

    res.json({ ok: true, ...relatorio });
  } catch (erro) {
    deletarArquivoSeExistir(req.file?.path);

    if (erro?.relatorio) {
      return res.status(Number(erro.statusCode) || 400).json({
        error: erro.message || "Nenhuma alteração foi aplicada. Verifique o relatório de erros.",
        relatorio: erro.relatorio
      });
    }

    res.status(500).json({
      error: erro.message || "Erro ao importar arquivo"
    });
  }
});

// =========================
// CORRIGIR CÓDIGOS ANTIGOS
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
app.get("/api/debug-itens", requireAdmin, async (req, res) => {
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
app.post("/api/reorganizar-codigos-fer", requireAdmin, async (req, res) => {
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
app.post("/api/sincronizar-sequencia-codigos", requireAdmin, async (req, res) => {
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
// EXPORTAR INVENTÁRIO PARA PDF
// =========================
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
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "Arquivo muito grande. O limite de importação é 10 MB."
    });
  }

  if (err) {
    return res.status(500).json({ error: err.message || "Erro interno no servidor" });
  }

  return next();
});

app.listen(PORT, HOST, () => {
  console.log(`UniqStock rodando em http://${HOST}:${PORT}`);
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

    const backup = await executarBackupAutomatico();
    ultimoBackupAutomaticoData = dataAtual;
    console.log("Backup automático concluído:", backup.file_name);
  } catch (e) {
    console.error("Erro no agendador de backup:", e.message);
  }
}, 1000 * 30);
