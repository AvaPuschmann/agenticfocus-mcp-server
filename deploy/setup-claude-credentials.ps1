# Prepare la connexion de Claude Code au serveur MCP AgenticFocus (Story 27-9).
#
# Cree  %USERPROFILE%\.agenticfocus\mcp-credentials.json  (URL Supabase et cle anon publique lues dans le .env du
# desktop ; votre e-mail et votre mot de passe saisis ICI, jamais affiches ni envoyes a quiconque), reserve ce
# fichier a votre compte Windows, puis verifie la connexion. Aucun secret n'est ecrit dans un depot git.
#
# Usage : clic droit sur le fichier > Executer avec PowerShell, ou dans un terminal PowerShell :
#   powershell -ExecutionPolicy Bypass -File "C:\KM\Assets\Claude\01 product\mcp-server\deploy\setup-claude-credentials.ps1"
$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..\..\agenticfocus-desktop\.env'
if (-not (Test-Path $envFile)) { throw "Fichier introuvable : $envFile" }
$vars = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $vars[$Matches[1]] = $Matches[2] }
}
$url = $vars['VITE_SUPABASE_URL']
$anon = $vars['VITE_SUPABASE_ANON_KEY']
if (-not $url -or -not $anon) { throw "VITE_SUPABASE_URL ou VITE_SUPABASE_ANON_KEY absent de $envFile" }

$email = Read-Host 'E-mail de votre compte AgenticFocus'
$secure = Read-Host 'Mot de passe (rien ne s''affiche a la frappe)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

$dir = Join-Path $env:USERPROFILE '.agenticfocus'
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir 'mcp-credentials.json'
$json = @{ supabase_url = $url; anon_key = $anon; email = $email; password = $plain } | ConvertTo-Json
# UTF-8 SANS BOM (Set-Content -Encoding UTF8 ajoute un BOM sous Windows PowerShell : Node ne le lirait pas)
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
icacls $file /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Remove-Variable plain, json, secure

Write-Host "Fichier cree : $file (lisible par votre seul compte Windows)"
Write-Host 'Verification de la connexion...'
$provider = Join-Path $PSScriptRoot 'token-provider.mjs'
$null = & node $provider
if ($LASTEXITCODE -eq 0) { Write-Host 'Connexion reussie. Vous pouvez fermer cette fenetre.' -ForegroundColor Green }
else { Write-Host 'Connexion refusee : verifiez l''e-mail et le mot de passe, puis relancez ce script.' -ForegroundColor Red }
