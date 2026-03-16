const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const outputPath = path.resolve(process.cwd(), "docs", "relatorio-resultados-2026-03-11.pdf");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const doc = new PDFDocument({
  margin: 50,
  size: "A4",
  info: {
    Title: "Relatorio de Resultados",
    Author: "Codex",
    Subject: "Resumo de validacoes do projeto",
    Keywords: "lint, testes, postgresql, inventario",
    CreationDate: new Date("2026-03-11T12:00:00Z")
  }
});

doc.pipe(fs.createWriteStream(outputPath));

doc.fontSize(18).text("Relatorio de Resultados", { align: "left" });
doc.moveDown(0.5);
doc.fontSize(10).text("Data: 11/03/2026");

doc.moveDown();
doc.fontSize(13).text("1. Validacao executada");
doc.moveDown(0.4);
doc.fontSize(11).text("- Comando executado: npm run lint");
doc.text("- HTMLHint: 16 arquivos verificados, sem erros.");
doc.text("- ESLint: sem erros apos o ajuste final.");

doc.moveDown();
doc.fontSize(13).text("2. Ajuste aplicado");
doc.moveDown(0.4);
doc.fontSize(11).text("- Warning removido em server.js.");
doc.text("- Funcao local nao utilizada removida: gerarChaveLicenca.");
doc.text("- Novo resultado: lint aprovado sem erros e sem warnings.");

doc.moveDown();
doc.fontSize(13).text("3. Avaliacao sobre suite de testes");
doc.moveDown(0.4);
doc.fontSize(11).text("- Nao ha impedimento tecnico para criar testes automatizados.");
doc.text("- Hoje o maior obstaculo e o acoplamento de regras, banco e rotas dentro de server.js.");
doc.text("- Caminho recomendado: iniciar com testes de integracao da API e banco temporario.");

doc.moveDown();
doc.fontSize(13).text("4. Avaliacao sobre migracao para PostgreSQL");
doc.moveDown(0.4);
doc.fontSize(11).text("- A migracao faz sentido para crescer o sistema com mais robustez e concorrencia.");
doc.text("- Nao e necessaria apenas para comecar a testar.");
doc.text("- Ordem recomendada: extrair camada de dados, padronizar migracoes e depois migrar o banco.");

doc.moveDown();
doc.fontSize(13).text("5. Arquivos alterados");
doc.moveDown(0.4);
doc.fontSize(11).text("- public/cadastro-ferramenta.html");
doc.text("- public/index.html");
doc.text("- server.js");

doc.end();

doc.on("finish", () => {
  process.stdout.write(outputPath);
});
