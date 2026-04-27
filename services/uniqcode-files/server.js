require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const path = require("path");
const { createDatabase } = require("../../lib/database");
const { runDb, getDb, allDb } = require("./lib/db");
const { initFilesSchema } = require("./lib/schema");

const app = express();
const SERVICE_NAME = "UniqCode Files";
const PORT = Number(process.env.UNIQCODE_FILES_PORT || 3100);
const API_TOKEN = String(process.env.UNIQCODE_FILES_API_TOKEN || "").trim();
const MAX_FILE_BYTES = Math.max(1, Number(process.env.UNIQCODE_FILES_MAX_FILE_BYTES || 25 * 1024 * 1024));
const PUBLIC_BASE_URL = String(process.env.UNIQCODE_FILES_PUBLIC_BASE_URL || "").trim();
const RUNTIME_BASE_DIR = process.env.UNIQCODE_FILES_RUNTIME_DIR
  ? path.resolve(process.env.UNIQCODE_FILES_RUNTIME_DIR)
  : path.join(__dirname, "runtime");
const DB_DIR = path.join(RUNTIME_BASE_DIR, "db");
const TMP_DIR = path.join(RUNTIME_BASE_DIR, "tmp");
const STORAGE_DIR = path.join(RUNTIME_BASE_DIR, "storage");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(RUNTIME_BASE_DIR);
ensureDir(DB_DIR);
ensureDir(TMP_DIR);
ensureDir(STORAGE_DIR);

if (!process.env.DB_CLIENT && process.env.UNIQCODE_FILES_DB_CLIENT) {
  process.env.DB_CLIENT = process.env.UNIQCODE_FILES_DB_CLIENT;
}
if (!process.env.DATABASE_URL && process.env.UNIQCODE_FILES_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.UNIQCODE_FILES_DATABASE_URL;
}
if (!process.env.PGHOST && process.env.UNIQCODE_FILES_PGHOST) {
  process.env.PGHOST = process.env.UNIQCODE_FILES_PGHOST;
}
if (!process.env.PGPORT && process.env.UNIQCODE_FILES_PGPORT) {
  process.env.PGPORT = process.env.UNIQCODE_FILES_PGPORT;
}
if (!process.env.PGDATABASE && process.env.UNIQCODE_FILES_PGDATABASE) {
  process.env.PGDATABASE = process.env.UNIQCODE_FILES_PGDATABASE;
}
if (!process.env.PGUSER && process.env.UNIQCODE_FILES_PGUSER) {
  process.env.PGUSER = process.env.UNIQCODE_FILES_PGUSER;
}
if (!process.env.PGPASSWORD && process.env.UNIQCODE_FILES_PGPASSWORD) {
  process.env.PGPASSWORD = process.env.UNIQCODE_FILES_PGPASSWORD;
}

const db = createDatabase({
  sqliteFile: path.join(DB_DIR, "uniqcode-files.db")
});
const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_FILE_BYTES
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getApiTokenFromRequest(req) {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return String(req.headers["x-ucf-token"] || "").trim();
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(503).json({
      error: "UniqCode Files sem token configurado. Defina UNIQCODE_FILES_API_TOKEN."
    });
  }

  const providedToken = getApiTokenFromRequest(req);
  if (!providedToken || providedToken !== API_TOKEN) {
    return res.status(401).json({ error: "Token invalido." });
  }

  return next();
}

function sanitizeSegment(value, fallback = "arquivo") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeBucket(value) {
  return sanitizeSegment(value, "general");
}

function getExtensionFromName(fileName) {
  const ext = path.extname(String(fileName || "")).trim().toLowerCase();
  return ext.length > 10 ? "" : ext;
}

function detectMimeType(file) {
  return String(file?.mimetype || "application/octet-stream").trim().toLowerCase();
}

function rowIsPublic(row) {
  return row?.is_public === true || Number(row?.is_public || 0) === 1;
}

function buildPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function buildPublicUrl(req, slug) {
  return `${buildPublicBaseUrl(req)}/public/${encodeURIComponent(slug)}`;
}

function buildDownloadUrl(req, id) {
  return `${buildPublicBaseUrl(req)}/api/files/${encodeURIComponent(id)}/download`;
}

function getAbsoluteStoragePath(row) {
  return path.resolve(STORAGE_DIR, String(row.relative_path || ""));
}

function mapFileRecord(req, row) {
  if (!row) return null;
  return {
    id: row.id,
    bucket: row.bucket,
    owner_type: row.owner_type,
    owner_ref: row.owner_ref,
    original_name: row.original_name,
    stored_name: row.stored_name,
    mime_type: row.mime_type,
    extension: row.extension,
    size_bytes: Number(row.size_bytes || 0),
    checksum_sha256: row.checksum_sha256,
    public_slug: row.public_slug,
    is_public: rowIsPublic(row),
    public_url: rowIsPublic(row) ? buildPublicUrl(req, row.public_slug) : null,
    download_url: buildDownloadUrl(req, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function sha256FromFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (_) {}
}

async function moveUploadedFile(tempPath, bucket, fileId, extension) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const targetDir = path.join(STORAGE_DIR, bucket, year, month);
  await fsp.mkdir(targetDir, { recursive: true });

  const finalName = `${fileId}${extension}`;
  const finalPath = path.join(targetDir, finalName);
  await fsp.rename(tempPath, finalPath);

  return {
    absolutePath: finalPath,
    storedName: finalName,
    relativePath: path.relative(STORAGE_DIR, finalPath).replace(/\\/g, "/")
  };
}

async function findActiveFileById(id) {
  return getDb(db, `
    SELECT *
    FROM ucf_files
    WHERE id = ?
      AND deleted_at IS NULL
  `, [id]);
}

async function findPublicFileBySlug(slug) {
  return getDb(db, `
    SELECT *
    FROM ucf_files
    WHERE public_slug = ?
      AND deleted_at IS NULL
  `, [slug]);
}

app.get("/", (req, res) => {
  const baseUrl = buildPublicBaseUrl(req);
  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${SERVICE_NAME}</title>
      <style>
        body{
          font-family:Arial, sans-serif;
          margin:0;
          padding:32px;
          background:#f6f8fb;
          color:#0f172a;
        }
        .wrap{
          max-width:860px;
          margin:0 auto;
          display:grid;
          gap:20px;
        }
        .card{
          background:#fff;
          border:1px solid #dbe3ef;
          border-radius:20px;
          padding:24px;
          box-shadow:0 12px 28px rgba(15, 23, 42, .05);
        }
        h1,h2,p,ul{
          margin:0;
        }
        .muted{
          color:#64748b;
        }
        .kicker{
          display:inline-flex;
          padding:8px 12px;
          border-radius:999px;
          background:#dbeafe;
          color:#1d4ed8;
          font-size:12px;
          font-weight:700;
          letter-spacing:.03em;
          text-transform:uppercase;
          margin-bottom:12px;
        }
        .grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
          gap:16px;
        }
        a{
          color:#1d4ed8;
          text-decoration:none;
          font-weight:700;
        }
        code{
          background:#eef2ff;
          padding:2px 6px;
          border-radius:8px;
        }
        ul{
          padding-left:18px;
          line-height:1.7;
        }
      </style>
    </head>
    <body>
      <main class="wrap">
        <section class="card">
          <span class="kicker">Servidor de arquivos</span>
          <h1>${SERVICE_NAME}</h1>
          <p class="muted">Serviço ativo para upload, consulta e publicação controlada de arquivos.</p>
        </section>

        <section class="grid">
          <article class="card">
            <h2>Status</h2>
            <p class="muted">Verificação rápida do serviço.</p>
            <p><a href="${baseUrl}/api/status">${baseUrl}/api/status</a></p>
          </article>

          <article class="card">
            <h2>Upload</h2>
            <p class="muted">Envie arquivos pela API protegida.</p>
            <p><code>POST /api/files</code></p>
            <p style="margin-top:10px;"><a href="${baseUrl}/upload">Abrir tela de upload</a></p>
          </article>

          <article class="card">
            <h2>Arquivo público</h2>
            <p class="muted">Acesso por slug público.</p>
            <p><code>GET /public/:slug</code></p>
          </article>
        </section>

        <section class="card">
          <h2>Endpoints principais</h2>
          <ul>
            <li><code>GET /api/status</code></li>
            <li><code>GET /api/files</code></li>
            <li><code>GET /api/files/:id</code></li>
            <li><code>GET /api/files/:id/download</code></li>
            <li><code>POST /api/files</code></li>
            <li><code>DELETE /api/files/:id</code></li>
            <li><code>GET /public/:slug</code></li>
          </ul>
        </section>
      </main>
    </body>
    </html>
  `;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/upload", (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Upload | ${SERVICE_NAME}</title>
      <style>
        body{
          font-family:Arial, sans-serif;
          margin:0;
          padding:32px;
          background:#f6f8fb;
          color:#0f172a;
        }
        .wrap{
          max-width:920px;
          margin:0 auto;
          display:grid;
          gap:20px;
        }
        .card{
          background:#fff;
          border:1px solid #dbe3ef;
          border-radius:20px;
          padding:24px;
          box-shadow:0 12px 28px rgba(15, 23, 42, .05);
        }
        .kicker{
          display:inline-flex;
          padding:8px 12px;
          border-radius:999px;
          background:#dbeafe;
          color:#1d4ed8;
          font-size:12px;
          font-weight:700;
          letter-spacing:.03em;
          text-transform:uppercase;
          margin-bottom:12px;
        }
        h1,h2,p,pre{
          margin:0;
        }
        p{
          line-height:1.55;
        }
        .muted{
          color:#64748b;
        }
        form{
          display:grid;
          gap:16px;
        }
        .grid{
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:16px;
        }
        .field{
          display:grid;
          gap:8px;
        }
        .field-full{
          grid-column:1 / -1;
        }
        label{
          font-weight:700;
          color:#0f172a;
        }
        input, select{
          min-height:46px;
          border:1px solid #cbd5e1;
          border-radius:14px;
          padding:0 14px;
          font-size:15px;
          background:#fff;
        }
        input[type="file"]{
          padding:10px 14px;
        }
        button{
          min-height:48px;
          border:0;
          border-radius:14px;
          background:#0f172a;
          color:#fff;
          font-size:15px;
          font-weight:700;
          cursor:pointer;
          padding:0 18px;
          width:max-content;
        }
        button:disabled{
          opacity:.65;
          cursor:wait;
        }
        pre{
          background:#0f172a;
          color:#e2e8f0;
          padding:18px;
          border-radius:16px;
          overflow:auto;
          line-height:1.5;
          font-size:13px;
        }
        a{
          color:#1d4ed8;
          text-decoration:none;
          font-weight:700;
        }
        @media (max-width: 780px){
          .grid{
            grid-template-columns:1fr;
          }
          button{
            width:100%;
          }
        }
      </style>
    </head>
    <body>
      <main class="wrap">
        <section class="card">
          <span class="kicker">Upload visual</span>
          <h1>Enviar arquivo para o ${SERVICE_NAME}</h1>
          <p class="muted">Use esta tela para validar uploads de fotos, notas fiscais e anexos sem precisar usar curl ou Postman.</p>
          <p style="margin-top:12px;"><a href="/">Voltar para a página inicial</a></p>
        </section>

        <section class="card">
          <form id="uploadForm">
            <div class="grid">
              <div class="field field-full">
                <label for="apiToken">Token da API</label>
                <input id="apiToken" name="apiToken" type="password" placeholder="Cole aqui o UNIQCODE_FILES_API_TOKEN" required>
              </div>

              <div class="field">
                <label for="bucket">Bucket</label>
                <input id="bucket" name="bucket" type="text" value="ferramentaria-fotos" required>
              </div>

              <div class="field">
                <label for="visibility">Visibilidade</label>
                <select id="visibility" name="visibility">
                  <option value="private">Privado</option>
                  <option value="public">Público</option>
                </select>
              </div>

              <div class="field">
                <label for="ownerType">Tipo de vínculo</label>
                <input id="ownerType" name="ownerType" type="text" value="ferramenta" placeholder="ferramenta, material, nota_fiscal">
              </div>

              <div class="field">
                <label for="ownerRef">Referência</label>
                <input id="ownerRef" name="ownerRef" type="text" value="FER-0001" placeholder="FER-0001, ALM-0001, NF-0001">
              </div>

              <div class="field field-full">
                <label for="fileInput">Arquivo</label>
                <input id="fileInput" name="fileInput" type="file" required>
              </div>
            </div>

            <button id="submitBtn" type="submit">Enviar arquivo</button>
          </form>
        </section>

        <section class="card">
          <h2>Resultado</h2>
          <p class="muted" style="margin:8px 0 14px;">A resposta da API vai aparecer aqui.</p>
          <pre id="resultBox">Aguardando envio...</pre>
        </section>
      </main>

      <script>
        const form = document.getElementById("uploadForm");
        const submitBtn = document.getElementById("submitBtn");
        const resultBox = document.getElementById("resultBox");

        function printResult(payload) {
          resultBox.textContent = typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2);
        }

        form.addEventListener("submit", async (event) => {
          event.preventDefault();

          const file = document.getElementById("fileInput").files[0];
          if (!file) {
            printResult({ error: "Selecione um arquivo antes de enviar." });
            return;
          }

          const formData = new FormData();
          formData.append("file", file);
          formData.append("bucket", document.getElementById("bucket").value);
          formData.append("owner_type", document.getElementById("ownerType").value);
          formData.append("owner_ref", document.getElementById("ownerRef").value);
          formData.append("visibility", document.getElementById("visibility").value);

          const token = document.getElementById("apiToken").value.trim();

          submitBtn.disabled = true;
          submitBtn.textContent = "Enviando...";
          printResult("Enviando arquivo...");

          try {
            const response = await fetch("/api/files", {
              method: "POST",
              headers: {
                "x-ucf-token": token
              },
              body: formData
            });

            const payload = await response.json().catch(() => ({
              error: "Resposta inválida."
            }));

            if (!response.ok) {
              printResult(payload);
              return;
            }

            printResult(payload);
          } catch (error) {
            printResult({
              error: error.message || "Falha ao enviar o arquivo."
            });
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Enviar arquivo";
          }
        });
      </script>
    </body>
    </html>
  `;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    port: PORT,
    db_client: db.client,
    runtime_dir: RUNTIME_BASE_DIR,
    public_base_url_configured: Boolean(PUBLIC_BASE_URL),
    max_file_bytes: MAX_FILE_BYTES
  });
});

app.get("/api/files", requireApiToken, async (req, res) => {
  try {
    const filters = ["deleted_at IS NULL"];
    const params = [];
    const bucket = req.query.bucket ? normalizeBucket(req.query.bucket) : "";
    const ownerType = String(req.query.owner_type || "").trim();
    const ownerRef = String(req.query.owner_ref || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (bucket) {
      filters.push("bucket = ?");
      params.push(bucket);
    }
    if (ownerType) {
      filters.push("owner_type = ?");
      params.push(ownerType);
    }
    if (ownerRef) {
      filters.push("owner_ref = ?");
      params.push(ownerRef);
    }

    const rows = await allDb(
      db,
      `
        SELECT *
        FROM ucf_files
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({
      ok: true,
      files: rows.map((row) => mapFileRecord(req, row))
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel listar arquivos." });
  }
});

app.get("/api/files/:id", requireApiToken, async (req, res) => {
  try {
    const row = await findActiveFileById(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "Arquivo nao encontrado." });
    }

    return res.json({
      ok: true,
      file: mapFileRecord(req, row)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Nao foi possivel consultar o arquivo." });
  }
});

app.get("/api/files/:id/download", requireApiToken, async (req, res) => {
  try {
    const row = await findActiveFileById(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "Arquivo nao encontrado." });
    }

    const absolutePath = getAbsoluteStoragePath(row);
    if (!fs.existsSync(absolutePath)) {
      return res.status(410).json({ error: "Arquivo removido do armazenamento." });
    }

    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    return res.download(absolutePath, row.original_name);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Nao foi possivel baixar o arquivo." });
  }
});

app.get("/public/:slug", async (req, res) => {
  try {
    const row = await findPublicFileBySlug(req.params.slug);
    if (!row || !rowIsPublic(row)) {
      return res.status(404).send("Arquivo publico nao encontrado.");
    }

    const absolutePath = getAbsoluteStoragePath(row);
    if (!fs.existsSync(absolutePath)) {
      return res.status(410).send("Arquivo indisponivel.");
    }

    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.sendFile(absolutePath);
  } catch (error) {
    return res.status(500).send(error.message || "Falha ao abrir arquivo publico.");
  }
});

app.post("/api/files", requireApiToken, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Envie um arquivo no campo 'file'." });
  }

  const tempPath = req.file.path;

  try {
    const bucket = normalizeBucket(req.body.bucket || "general");
    const ownerType = String(req.body.owner_type || "").trim() || null;
    const ownerRef = String(req.body.owner_ref || "").trim() || null;
    const isPublic = ["1", "true", "public", "sim", "yes"].includes(
      String(req.body.visibility || req.body.is_public || "").trim().toLowerCase()
    );
    const fileId = `ucf_${crypto.randomBytes(10).toString("hex")}`;
    const extension = getExtensionFromName(req.file.originalname);
    const checksum = await sha256FromFile(tempPath);
    const publicSlug = `${sanitizeSegment(path.parse(req.file.originalname).name, "arquivo")}-${crypto.randomBytes(4).toString("hex")}`;
    const moved = await moveUploadedFile(tempPath, bucket, fileId, extension);

    await runDb(
      db,
      `
        INSERT INTO ucf_files (
          id, bucket, owner_type, owner_ref, original_name, stored_name, mime_type,
          extension, size_bytes, checksum_sha256, relative_path, public_slug, is_public
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        fileId,
        bucket,
        ownerType,
        ownerRef,
        req.file.originalname,
        moved.storedName,
        detectMimeType(req.file),
        extension,
        Number(req.file.size || 0),
        checksum,
        moved.relativePath,
        publicSlug,
        isPublic ? 1 : 0
      ]
    );

    const row = await findActiveFileById(fileId);
    return res.status(201).json({
      ok: true,
      file: mapFileRecord(req, row)
    });
  } catch (error) {
    await safeUnlink(tempPath);
    return res.status(500).json({ error: error.message || "Nao foi possivel salvar o arquivo." });
  }
});

app.delete("/api/files/:id", requireApiToken, async (req, res) => {
  try {
    const row = await findActiveFileById(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "Arquivo nao encontrado." });
    }

    const absolutePath = getAbsoluteStoragePath(row);
    await safeUnlink(absolutePath);

    await runDb(
      db,
      `
        UPDATE ucf_files
        SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [req.params.id]
    );

    return res.json({ ok: true, deleted: true, id: req.params.id });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Nao foi possivel remover o arquivo." });
  }
});

async function bootstrap() {
  await initFilesSchema(db);
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} rodando em http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error(`Falha ao iniciar ${SERVICE_NAME}:`, error);
  process.exit(1);
});
