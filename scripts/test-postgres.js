require("dotenv").config();

const { createDatabase } = require("../lib/database");

async function main() {
  process.env.DB_CLIENT = "postgres";

  const db = createDatabase({ sqliteFile: "" });

  try {
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT NOW() AS agora, current_database() AS banco, current_user AS usuario", [], (error, data) => {
        if (error) return reject(error);
        resolve(data);
      });
    });

    console.log("Conexão Postgres: OK");
    console.log(`Banco: ${row?.banco || "-"}`);
    console.log(`Usuário: ${row?.usuario || "-"}`);
    console.log(`Horário do servidor: ${row?.agora || "-"}`);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

main().catch((error) => {
  const message = String(error?.message || error || "");
  console.error("Falha ao conectar no Postgres:", message);

  if (message.includes("SCRAM-SERVER-FIRST-MESSAGE")) {
    console.error("");
    console.error("O Postgres desta instalacao exige senha.");
    console.error("Defina DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD no .env.");
    console.error("Exemplo:");
    console.error("DB_CLIENT=postgres");
    console.error("PGHOST=localhost");
    console.error("PGPORT=5432");
    console.error("PGDATABASE=uniqstock");
    console.error("PGUSER=postgres");
    console.error("PGPASSWORD=sua_senha_do_postgres");
  }

  process.exitCode = 1;
});
