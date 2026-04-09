const required = ["CSC_LINK", "CSC_KEY_PASSWORD"];
const missing = required.filter((key) => !process.env[key] || !String(process.env[key]).trim());

if (missing.length > 0) {
  console.error("Assinatura digital não configurada.");
  console.error("Defina as variáveis de ambiente antes do build assinado:");
  missing.forEach((key) => console.error(`- ${key}`));
  console.error("");
  console.error("Exemplo (PowerShell):");
  console.error('$env:CSC_LINK="C:\\\\certs\\\\uniqcode-code-sign.pfx"');
  console.error('$env:CSC_KEY_PASSWORD="SUA_SENHA_DO_CERTIFICADO"');
  console.error("npm run dist:win:signed");
  process.exit(1);
}

console.log("Variáveis de assinatura encontradas. Prosseguindo com build assinado...");
