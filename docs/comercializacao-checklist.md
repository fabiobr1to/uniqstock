# Checklist de Comercializacao

## Variaveis obrigatorias para release comercial

- `SESSION_SECRET`: segredo forte e exclusivo do ambiente.
- `UNIQSTOCK_COMMERCIAL_API_URL`: URL base da API comercial de licenca/update.
- `UNIQSTOCK_COMMERCIAL_API_TOKEN`: token da API comercial com escopo minimo.
- `UNIQSTOCK_UPDATE_ALLOWED_HOSTS`: lista de hosts permitidos para baixar instaladores.
- `UNIQSTOCK_REQUIRE_SIGNED_INSTALLER=1`: manter validacao de SHA-256 obrigatoria.

## Antes de gerar o instalador

1. Confirmar que o build nao esta carregando `SUPABASE_SERVICE_ROLE_KEY`.
2. Confirmar que `db/**`, `runtime/**`, `updates/**`, `.env*` e `*.db` nao entram no pacote.
3. Rodar `node --check server.js` e `node --check electron-main.js`.
4. Revisar a versao em `package.json`.

## Validacao minima do pacote

1. Gerar build com `npm run dist:win:unsigned` ou o fluxo assinado da release.
2. Instalar em maquina limpa.
3. Abrir o app e confirmar que o backend sobe em `127.0.0.1`.
4. Ativar licenca no fluxo inicial.
5. Fazer login administrativo.
6. Cadastrar item, editar item e registrar entrada/saida.
7. Executar backup manual e confirmar criacao do arquivo.
8. Verificar atualizacao e confirmar que o download usa `/api/app/update-download`.
9. Desinstalar e confirmar que o runtime do usuario fica no local esperado.

## Operacao e suporte

### Backup e restauracao

1. Backup manual: Configuracoes -> Executar backup agora.
2. Restauracao: fechar o app, substituir `runtime/db/inventario.db` por backup valido e reabrir.
3. Validar `PRAGMA integrity_check` antes de restaurar em cliente.

### Licenca

1. Ativacao inicial pode ser feita sem login.
2. Troca de licenca depois da ativacao inicial exige admin.
3. Se a API comercial estiver indisponivel, usar o cache remoto apenas como contingencia temporaria.

### Atualizacao

1. Publicar release com `version`, `url_installer`, `sha256`, `published_at` e `active`.
2. Usar host listado em `UNIQSTOCK_UPDATE_ALLOWED_HOSTS`.
3. Nao liberar instalador sem `sha256`.

## Sinais de liberacao

- Fluxo principal validado em runtime isolado.
- Backup consistente retornando `integrity_check = ok`.
- Sessao persistente gravando em `app_sessions`.
- Instalador empacotado sem banco local ou segredos indevidos.
