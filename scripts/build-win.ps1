param(
  [switch]$Signed,
  [string]$CertPath = "",
  [string]$CertPassword = ""
)

$ErrorActionPreference = "Stop"

if ($Signed) {
  if ([string]::IsNullOrWhiteSpace($CertPath) -or [string]::IsNullOrWhiteSpace($CertPassword)) {
    Write-Host "Uso (assinado):"
    Write-Host ".\scripts\build-win.ps1 -Signed -CertPath 'C:\certs\uniqcode-code-sign.pfx' -CertPassword 'SENHA'"
    exit 1
  }

  if (-not (Test-Path $CertPath)) {
    Write-Host "Certificado não encontrado em: $CertPath"
    exit 1
  }

  $env:CSC_LINK = $CertPath
  $env:CSC_KEY_PASSWORD = $CertPassword
  Write-Host "Gerando instalador ASSINADO..."
  npm run dist:win:signed
  exit $LASTEXITCODE
}

Write-Host "Gerando instalador SEM assinatura..."
npm run dist:win:unsigned
exit $LASTEXITCODE
