const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SECURITY_STATE_FILENAME = ".runtime-security.json";
const BOOTSTRAP_CREDENTIALS_FILENAME = "bootstrap-admin.txt";
const INSECURE_LICENSE_SECRET = "uniqstock-license-secret-change";
const MIN_SESSION_SECRET_LENGTH = 32;
const LICENSE_MODES = new Set(["local", "supabase"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(normalizeText(value).toLowerCase());
}

function detectProductionInstall(env = process.env) {
  return isTruthy(env.UNIQSTOCK_APP_PACKAGED) || isTruthy(env.UNIQSTOCK_PRODUCTION_INSTALL);
}

function validateStrongPassword(password) {
  const text = String(password || "");
  if (text.length < 8) return "Senha deve ter ao menos 8 caracteres";
  if (!/[A-Z]/.test(text)) return "Senha deve conter ao menos 1 letra maiúscula";
  if (!/[a-z]/.test(text)) return "Senha deve conter ao menos 1 letra minúscula";
  if (!/[0-9]/.test(text)) return "Senha deve conter ao menos 1 número";
  if (!/[^A-Za-z0-9]/.test(text)) return "Senha deve conter ao menos 1 caractere especial";
  return null;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getSecurityPaths(runtimeBaseDir) {
  return {
    securityStateFile: path.join(runtimeBaseDir, SECURITY_STATE_FILENAME),
    bootstrapCredentialsFile: path.join(runtimeBaseDir, BOOTSTRAP_CREDENTIALS_FILENAME)
  };
}

function readSecurityState(filePath) {
  if (!fs.existsSync(filePath)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Não foi possível ler ${path.basename(filePath)}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} está em formato inválido.`);
  }

  return parsed;
}

function writeSecurityState(filePath, state) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function generateStrongPassword(length = 20) {
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%*-_+=";
  const alphabet = `${uppercase}${lowercase}${digits}${symbols}`;
  const chars = [
    uppercase[crypto.randomInt(uppercase.length)],
    lowercase[crypto.randomInt(lowercase.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)]
  ];

  while (chars.length < length) {
    chars.push(alphabet[crypto.randomInt(alphabet.length)]);
  }

  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }

  return chars.join("");
}

function withSecurityState(runtimeBaseDir, mutator) {
  ensureDirectory(runtimeBaseDir);
  const paths = getSecurityPaths(runtimeBaseDir);
  const state = readSecurityState(paths.securityStateFile);
  const initialSnapshot = JSON.stringify(state);

  if (!normalizeText(state.installId)) {
    state.installId = randomToken(16);
  }
  if (!normalizeText(state.createdAt)) {
    state.createdAt = new Date().toISOString();
  }

  const result = mutator(state, paths) || {};
  const changed = JSON.stringify(state) !== initialSnapshot;

  if (changed) {
    state.updatedAt = new Date().toISOString();
    writeSecurityState(paths.securityStateFile, state);
  }

  return { ...result, changed, state, paths };
}

function ensureRuntimeSecurity({ runtimeBaseDir, env = process.env }) {
  const envSessionSecret = normalizeText(env.SESSION_SECRET);
  if (envSessionSecret && envSessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET precisa ter ao menos ${MIN_SESSION_SECRET_LENGTH} caracteres.`);
  }

  return withSecurityState(runtimeBaseDir, (state) => {
    if (!normalizeText(state.sessionSecret)) {
      state.sessionSecret = randomToken(48);
    }

    return {
      installId: state.installId,
      sessionSecret: envSessionSecret || state.sessionSecret,
      sessionSecretSource: envSessionSecret ? "env" : "runtime"
    };
  });
}

function resolveBootstrapAdminPassword({ runtimeBaseDir, env = process.env }) {
  const envPassword = normalizeText(env.UNIQSTOCK_ADMIN_PASSWORD);
  const passwordError = validateStrongPassword(envPassword);

  if (envPassword) {
    if (passwordError) {
      throw new Error(`UNIQSTOCK_ADMIN_PASSWORD invalida: ${passwordError}.`);
    }

    return { password: envPassword, source: "env", paths: getSecurityPaths(runtimeBaseDir) };
  }

  return withSecurityState(runtimeBaseDir, (state) => {
    if (!normalizeText(state.bootstrapAdminPassword)) {
      state.bootstrapAdminPassword = generateStrongPassword();
      state.bootstrapAdminGeneratedAt = new Date().toISOString();
    }

    return {
      password: state.bootstrapAdminPassword,
      source: "runtime"
    };
  });
}

function writeBootstrapCredentialsFile({
  runtimeBaseDir,
  username = "admin",
  password,
  installId = "",
  stateFile = ""
}) {
  const paths = getSecurityPaths(runtimeBaseDir);
  const content = [
    "UniqStock - credenciais iniciais do administrador",
    "",
    `Usuário: ${username}`,
    `Senha inicial: ${password}`,
    installId ? `Instalacao: ${installId}` : null,
    "",
    "Altere essa senha imediatamente apos o primeiro login.",
    stateFile ? `Arquivo de runtime: ${stateFile}` : null,
    ""
  ].filter(Boolean).join("\n");

  fs.writeFileSync(paths.bootstrapCredentialsFile, content, "utf8");
  return paths.bootstrapCredentialsFile;
}

function clearBootstrapAdminArtifacts({ runtimeBaseDir }) {
  const paths = getSecurityPaths(runtimeBaseDir);

  withSecurityState(runtimeBaseDir, (state) => {
    delete state.bootstrapAdminPassword;
    delete state.bootstrapAdminGeneratedAt;
    state.bootstrapAdminClearedAt = new Date().toISOString();
    return null;
  });

  if (fs.existsSync(paths.bootstrapCredentialsFile)) {
    fs.unlinkSync(paths.bootstrapCredentialsFile);
  }
}

function resolveLocalLicenseSecret({
  runtimeBaseDir,
  env = process.env,
  productionInstall = detectProductionInstall(env)
}) {
  const explicitSecret = normalizeText(env.UNIQSTOCK_LICENSE_SECRET);

  if (explicitSecret) {
    if (explicitSecret === INSECURE_LICENSE_SECRET) {
      throw new Error("UNIQSTOCK_LICENSE_SECRET usa um valor inseguro conhecido. Defina um segredo exclusivo.");
    }
    if (explicitSecret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`UNIQSTOCK_LICENSE_SECRET precisa ter ao menos ${MIN_SESSION_SECRET_LENGTH} caracteres.`);
    }

    return { secret: explicitSecret, source: "env", paths: getSecurityPaths(runtimeBaseDir) };
  }

  if (productionInstall) {
    throw new Error("Licenciamento local em produção exige UNIQSTOCK_LICENSE_SECRET explícito.");
  }

  return withSecurityState(runtimeBaseDir, (state) => {
    if (!normalizeText(state.localLicenseSecret)) {
      state.localLicenseSecret = randomToken(48);
    }

    return {
      secret: state.localLicenseSecret,
      source: "runtime"
    };
  });
}

function resolveLicenseRuntime({
  runtimeBaseDir,
  env = process.env,
  productionInstall = detectProductionInstall(env)
}) {
  const explicitMode = normalizeText(env.UNIQSTOCK_LICENSE_MODE).toLowerCase();
  const deprecatedForceLocal = isTruthy(env.UNIQSTOCK_FORCE_LOCAL_LICENSE);
  const hasSupabaseConfig = Boolean(
    normalizeText(env.SUPABASE_URL) &&
    normalizeText(env.SUPABASE_SERVICE_ROLE_KEY)
  );
  const allowLocalInProduction = isTruthy(env.UNIQSTOCK_ALLOW_LOCAL_LICENSE_IN_PRODUCTION);

  if (explicitMode && !LICENSE_MODES.has(explicitMode)) {
    throw new Error("UNIQSTOCK_LICENSE_MODE inválido. Use 'local' ou 'supabase'.");
  }

  if (productionInstall && !explicitMode && !hasSupabaseConfig) {
    throw new Error(
      "Instalação de produção sem licenciamento configurado. Defina " +
      "UNIQSTOCK_LICENSE_MODE=supabase com credenciais do Supabase, ou " +
      "habilite UNIQSTOCK_LICENSE_MODE=local com " +
      "UNIQSTOCK_ALLOW_LOCAL_LICENSE_IN_PRODUCTION=1 e UNIQSTOCK_LICENSE_SECRET exclusivo."
    );
  }

  const mode = explicitMode || (deprecatedForceLocal ? "local" : (hasSupabaseConfig ? "supabase" : "local"));
  if (mode === "supabase") {
    if (!hasSupabaseConfig) {
      throw new Error("UNIQSTOCK_LICENSE_MODE=supabase exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
    }

    return {
      mode,
      useSupabase: true,
      localLicenseSecret: null,
      localLicenseSecretSource: null
    };
  }

  if (productionInstall && !allowLocalInProduction) {
    throw new Error(
      "Licenciamento local está bloqueado em instalações de produção. " +
      "Use UNIQSTOCK_LICENSE_MODE=supabase ou habilite " +
      "UNIQSTOCK_ALLOW_LOCAL_LICENSE_IN_PRODUCTION=1 com um segredo exclusivo."
    );
  }

  const localLicense = resolveLocalLicenseSecret({
    runtimeBaseDir,
    env,
    productionInstall
  });

  return {
    mode,
    useSupabase: false,
    localLicenseSecret: localLicense.secret,
    localLicenseSecretSource: localLicense.source
  };
}

module.exports = {
  BOOTSTRAP_CREDENTIALS_FILENAME,
  INSECURE_LICENSE_SECRET,
  clearBootstrapAdminArtifacts,
  detectProductionInstall,
  ensureRuntimeSecurity,
  resolveBootstrapAdminPassword,
  resolveLicenseRuntime,
  resolveLocalLicenseSecret,
  validateStrongPassword,
  writeBootstrapCredentialsFile
};
