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

    console.log("Conexao Postgres: OK");
    console.log(`Banco: ${row?.banco || "-"}`);
    console.log(`Usuario: ${row?.usuario || "-"}`);
    console.log(`Horario servidor: ${row?.agora || "-"}`);
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error("Falha ao conectar no Postgres:", error.message);
  process.exitCode = 1;
});
