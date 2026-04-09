# uniqstock

Atualizacao com melhorias gerais e correcoes de estabilidade.

## Ambiente local

- Node suportado: `22.x`
- Arquivo de referencia de versao: `.nvmrc`
- Banco padrao: `SQLite`

Se o PowerShell bloquear `npm` por causa de execution policy, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd start
```

O projeto nao esta homologado para `Node 24` neste momento. Nessa versao, o modulo nativo `sqlite3` pode falhar no bootstrap da aplicacao.

Opcionalmente, defina `UNIQSTOCK_ADMIN_PASSWORD` antes do primeiro bootstrap para personalizar a senha inicial do usuario `admin`.

## Banco de dados

O projeto continua usando `SQLite` por padrao.

Preparacao inicial para `Postgres` ja existe:

- variavel `DB_CLIENT`
- camada de conexao em `lib/database.js`
- dependencia `pg`

Configuracao atual:

- `DB_CLIENT=sqlite`: modo padrao e operacional
- `DB_CLIENT=postgres`: infraestrutura inicial pronta, com adaptacoes de schema e SQL ainda pendentes

Variaveis previstas para Postgres:

- `DB_CLIENT=postgres`
- `DATABASE_URL` ou `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- copie `.env.example` para `.env` e preencha os valores

## Migracao SQLite -> Postgres

Scripts disponiveis:

- `npm.cmd run db:test:postgres`
- `npm.cmd run db:migrate:postgres`

Origem padrao do SQLite:

- `.\db\inventario.db`

Variaveis opcionais:

- `SQLITE_SOURCE_PATH` para apontar outro arquivo `.db`
- `DATABASE_URL` ou `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` para o destino Postgres
