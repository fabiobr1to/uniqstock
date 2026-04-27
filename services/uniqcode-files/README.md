# UniqCode Files

Servidor de arquivos da UniqCode para fotos, notas fiscais, anexos e outros documentos.

## O que este MVP faz

- recebe upload protegido por token
- salva o arquivo em disco no runtime proprio do servico
- salva metadados no banco
- gera URL publica por `slug`
- permite consulta, listagem, download protegido e exclusao logica

## Estrutura

- `services/uniqcode-files/server.js`: API do servico
- `services/uniqcode-files/lib/schema.js`: schema do banco
- `services/uniqcode-files/lib/db.js`: helpers async do banco
- `services/uniqcode-files/runtime/`: banco local, temporarios e armazenamento

## Endpoints

- `GET /api/status`
- `GET /api/files` protegida por token
- `GET /api/files/:id` protegida por token
- `GET /api/files/:id/download` protegida por token
- `POST /api/files` protegida por token
- `DELETE /api/files/:id` protegida por token
- `GET /public/:slug`

## Headers de autenticacao

Use um destes:

- `Authorization: Bearer SEU_TOKEN`
- `x-ucf-token: SEU_TOKEN`

## Campos do upload

- `file`: arquivo binario
- `bucket`: ex. `ferramentaria-fotos`, `ferramentaria-notas`, `almoxarifado-fotos`
- `owner_type`: ex. `ferramenta`, `material`, `nota_fiscal`
- `owner_ref`: ex. `FER-0006`, `ALM-0012`
- `visibility` ou `is_public`: `public`, `true`, `1` para URL publica

## Exemplo de upload

```powershell
curl -X POST "http://localhost:3100/api/files" ^
  -H "Authorization: Bearer SEU_TOKEN" ^
  -F "bucket=ferramentaria-fotos" ^
  -F "owner_type=ferramenta" ^
  -F "owner_ref=FER-0006" ^
  -F "visibility=public" ^
  -F "file=@D:\\fotos\\fer-0006.jpg"
```

## Script

No projeto raiz:

```powershell
npm.cmd run files:start
```

## Proximos passos recomendados

- miniaturas automaticas para imagens
- pagina publica por item usando o `slug`
- substituicao versionada de arquivos
- integracao direta com o UniqStock
