# Assinatura do Instalador Windows (.exe)

## Pré-requisitos
- Certificado de code signing em `.pfx` (da UniqCode).
- Senha do certificado.

## Build sem assinatura (teste interno)
```powershell
npm run dist:win:unsigned
```

Ou com script único:
```powershell
.\scripts\build-win.ps1
```

## Build assinado
No PowerShell, antes de rodar o build:

```powershell
$env:CSC_LINK="C:\certs\uniqcode-code-sign.pfx"
$env:CSC_KEY_PASSWORD="SENHA_DO_PFX"
npm run dist:win:signed
```

Ou com script único:
```powershell
.\scripts\build-win.ps1 -Signed -CertPath "C:\certs\uniqcode-code-sign.pfx" -CertPassword "SENHA_DO_PFX"
```

## Variáveis usadas
- `CSC_LINK`: caminho local do arquivo `.pfx`.
- `CSC_KEY_PASSWORD`: senha do certificado.

## Saída
- Pasta: `dist/`
- Arquivo esperado: `UniqStock-Setup-<versao>.exe`

## Observações
- Sem certificado válido, o Windows pode exibir alerta de editor desconhecido.
- Com certificado válido, o instalador mostra a publicadora `UniqCode Programação`.
