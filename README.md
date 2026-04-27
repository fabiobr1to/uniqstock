# uniqstock

Atualização com melhorias gerais e correções de estabilidade.

## Ambiente local

- Node suportado: `22.x`
- Arquivo de referência de versão: `.nvmrc`
- Banco padrão: `SQLite`

Se o PowerShell bloquear `npm` por causa de execution policy, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd start
```

O projeto não está homologado para `Node 24` neste momento. Nessa versão, o módulo nativo `sqlite3` pode falhar no bootstrap da aplicação.

Se `UNIQSTOCK_ADMIN_PASSWORD` não for definido, a instalação gera uma senha forte
por máquina quando o admin bootstrap for criado e salva as credenciais iniciais em
`bootstrap-admin.txt` no runtime. O arquivo é removido quando o próprio `admin`
altera a senha em `Perfil`.

## Banco de dados

O projeto continua usando `SQLite` por padrão.

`Postgres` está operacional:

- `DB_CLIENT=sqlite`: modo padrão e operacional
- `DB_CLIENT=postgres`: schema, migração e smoke test suportados

Variáveis previstas para Postgres:

- `DB_CLIENT=postgres`
- `DATABASE_URL` ou `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- copie `.env.example` para `.env` e preencha os valores

## Migração SQLite -> Postgres

Scripts disponíveis:

- `npm.cmd run db:test:postgres`
- `npm.cmd run db:migrate:postgres`
- `npm.cmd run smoke:postgres`

Origem padrão do SQLite:

- `.\db\inventario.db`

Variáveis opcionais:

- `SQLITE_SOURCE_PATH` para apontar outro arquivo `.db`
- `DATABASE_URL` ou `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` para o destino Postgres

## Segurança de instalação

Os fallbacks inseguros de `dev-secret`, `admin123` e segredo padrão de licença
foram removidos do bootstrap operacional.

- `SESSION_SECRET`: em produção, precisa ter pelo menos 32 caracteres
- `UNIQSTOCK_ADMIN_PASSWORD`: opcional; se ausente, a instalação gera uma senha forte por máquina
- `UNIQSTOCK_LICENSE_MODE=supabase`: modo recomendado para cliente real
- `UNIQSTOCK_LICENSE_MODE=local`: permitido por padrão apenas em desenvolvimento
- `UNIQSTOCK_ALLOW_LOCAL_LICENSE_IN_PRODUCTION=1`: override explícito para instalações offline
- `UNIQSTOCK_LICENSE_SECRET`: obrigatório para `local` em produção
- `UNIQSTOCK_FORCE_LOCAL_LICENSE=1`: alias legado para desenvolvimento/local

O runtime local guarda os segredos gerados em `.runtime-security.json`, que não deve
ser versionado nem empacotado.

## Instalador Windows assinado

Builds disponíveis:

- `npm.cmd run dist:win:unsigned`
- `npm.cmd run dist:win:signed`

Para build assinado, defina:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`

## UniqCode Files

O workspace agora inclui um MVP do servidor de arquivos `UniqCode Files` em:

- `services/uniqcode-files/server.js`

Script disponivel:

- `npm.cmd run files:start`

Documentacao inicial:

- `services/uniqcode-files/README.md`
