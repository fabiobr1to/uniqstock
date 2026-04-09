const crypto = require("crypto");

const SECRET = process.env.UNIQSTOCK_LICENSE_SECRET || "uniqstock-license-secret-change";

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizarDataIso(dataTexto) {
  const texto = String(dataTexto || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T00:00:00`);
  if (Number.isNaN(data.getTime())) return null;
  return texto;
}

function assinar(payloadB64) {
  return toBase64Url(
    crypto.createHmac("sha256", SECRET).update(payloadB64).digest()
  );
}

function gerarChave(cliente, expiraEm, codigoMaquina) {
  const clienteLimpo = String(cliente || "").trim();
  const dataIso = normalizarDataIso(expiraEm);
  const maquina = String(codigoMaquina || "").trim().toUpperCase();
  if (!clienteLimpo || !dataIso) {
    throw new Error("Uso: npm run licenca:gerar -- \"Nome do Cliente\" 2026-12-31 MCH-XXXXXXXXXXXXXXX");
  }

  const payload = {
    v: 1,
    cliente: clienteLimpo,
    exp: dataIso,
    iat: new Date().toISOString(),
    mch: maquina || undefined
  };

  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const assinatura = assinar(payloadB64);
  return `USK1.${payloadB64}.${assinatura}`;
}

const cliente = process.argv[2];
const expiraEm = process.argv[3];
const codigoMaquina = process.argv[4];

try {
  const chave = gerarChave(cliente, expiraEm, codigoMaquina);
  console.log("\nChave de licença gerada com sucesso:");
  console.log(chave);
  console.log("\nCliente:", cliente);
  console.log("Expira em:", expiraEm);
  console.log("Máquina:", codigoMaquina || "(não vinculada)");
} catch (e) {
  console.error("\nErro:", e.message);
  process.exit(1);
}
