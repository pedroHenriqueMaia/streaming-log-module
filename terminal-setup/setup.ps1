# ============================================================
# Terminal Dev Setup — Pedro
# Execute UMA VEZ como Administrador no PowerShell:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#   .\terminal-setup\setup.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$THEME_NAME = "streaming-dev"
$SETUP_DIR  = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param($msg) Write-Host "`n  $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip { param($msg) Write-Host "  [--] $msg" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ██████  dev terminal setup" -ForegroundColor Magenta
Write-Host "  Instalando: Oh My Posh + Nerd Font + PS Modules + VSCode" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Oh My Posh ─────────────────────────────────────────────────────────────
Write-Step "Instalando Oh My Posh..."
if (Get-Command oh-my-posh -ErrorAction SilentlyContinue) {
    Write-Skip "Oh My Posh ja instalado"
} else {
    winget install JanDeDobbeleer.OhMyPosh -s winget --silent
    Write-Ok "Oh My Posh instalado"
}

# ── 2. Nerd Font — CaskaydiaCove ──────────────────────────────────────────────
Write-Step "Instalando CaskaydiaCove Nerd Font..."
try {
    oh-my-posh font install CascadiaCode
    Write-Ok "CaskaydiaCove Nerd Font instalada"
} catch {
    Write-Host "  [!] Instale manualmente: https://www.nerdfonts.com/font-downloads" -ForegroundColor Yellow
    Write-Host "      (baixe CaskaydiaCove Nerd Font)" -ForegroundColor Yellow
}

# ── 3. PowerShell Modules ─────────────────────────────────────────────────────
Write-Step "Instalando modulos PowerShell..."

$modules = @(
    @{ Name = "Terminal-Icons";       Desc = "icones coloridos no ls" },
    @{ Name = "PSReadLine";           Desc = "autocomplete inteligente" },
    @{ Name = "z";                    Desc = "navegacao rapida de pastas" },
    @{ Name = "posh-git";             Desc = "git autocomplete" }
)

foreach ($mod in $modules) {
    if (Get-Module -ListAvailable -Name $mod.Name) {
        Write-Skip "$($mod.Name) ja instalado"
    } else {
        Install-Module $mod.Name -Scope CurrentUser -Force -SkipPublisherCheck
        Write-Ok "$($mod.Name) — $($mod.Desc)"
    }
}

# ── 4. Copiar tema Oh My Posh ─────────────────────────────────────────────────
Write-Step "Copiando tema Oh My Posh..."
$ompConfigDir = "$env:USERPROFILE\.config\oh-my-posh"
if (-not (Test-Path $ompConfigDir)) { New-Item -ItemType Directory -Path $ompConfigDir | Out-Null }
$themeSrc = Join-Path $SETUP_DIR "$THEME_NAME.omp.json"
$themeDst = "$ompConfigDir\$THEME_NAME.omp.json"
Copy-Item $themeSrc $themeDst -Force
Write-Ok "Tema copiado para $themeDst"

# ── 5. PowerShell Profile ─────────────────────────────────────────────────────
Write-Step "Configurando PowerShell Profile..."

$profileDir = Split-Path $PROFILE
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir | Out-Null }

$profileContent = @"
# ─── Dev Terminal Profile ───────────────────────────────────────────────
# Gerado pelo streaming-dev setup

# Oh My Posh — prompt bonito
`$env:POSH_THEME = "$themeDst"
oh-my-posh init pwsh --config "`$env:POSH_THEME" | Invoke-Expression

# Icones coloridos no Get-ChildItem / ls
Import-Module Terminal-Icons -ErrorAction SilentlyContinue

# Navegacao rapida (z logs, z projects, etc.)
Import-Module z -ErrorAction SilentlyContinue

# Git autocomplete
Import-Module posh-git -ErrorAction SilentlyContinue

# PSReadLine — autocomplete estilo fish/zsh
Set-PSReadLineOption -PredictionSource History
Set-PSReadLineOption -PredictionViewStyle ListView
Set-PSReadLineOption -EditMode Windows
Set-PSReadLineKeyHandler -Key Tab            -Function MenuComplete
Set-PSReadLineKeyHandler -Key UpArrow        -Function HistorySearchBackward
Set-PSReadLineKeyHandler -Key DownArrow      -Function HistorySearchForward
Set-PSReadLineKeyHandler -Key Ctrl+d         -Function DeleteChar
Set-PSReadLineKeyHandler -Key Ctrl+w         -Function BackwardDeleteWord

# Aliases uteis de dev
Set-Alias -Name g      -Value git
Set-Alias -Name k      -Value kubectl
Set-Alias -Name d      -Value docker
Set-Alias -Name dc     -Value "docker compose"
Set-Alias -Name ll     -Value Get-ChildItem
Set-Alias -Name which  -Value Get-Command

# Funcoes rapidas
function dev    { Set-Location ~\Documents; Write-Host " Workspace" -ForegroundColor Cyan }
function logs   { Set-Location ~\Documents\logs }
function cls2   { Clear-Host; oh-my-posh init pwsh --config "`$env:POSH_THEME" | Invoke-Expression }

# Docker shortcuts
function dps    { docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" }
function dlogs  { param(`$s) docker compose logs -f --tail=100 `$s }
function dup    { docker compose up -d --build }
function ddown  { docker compose down }

# Git shortcuts
function gs     { git status }
function ga     { git add . }
function gc     { param(`$m) git commit -m `$m }
function gp     { git push }
function gl     { git log --oneline --graph --decorate -20 }
function gco    { param(`$b) git checkout `$b }

# Info ao abrir o terminal
Write-Host ""
Write-Host "  node   `$(node -v 2>null)   git `$(git --version 2>null | Select-String -Pattern '\d+\.\d+\.\d+')   docker `$(docker --version 2>null | Select-String -Pattern '\d+\.\d+\.\d+')" -ForegroundColor DarkGray
Write-Host ""
"@

Set-Content -Path $PROFILE -Value $profileContent -Encoding UTF8
Write-Ok "Profile salvo em: $PROFILE"

# ── 6. VSCode settings.json ───────────────────────────────────────────────────
Write-Step "Configurando VSCode terminal..."

$vscodeCfgPath = "$env:APPDATA\Code\User\settings.json"
$vscodeInsidersPath = "$env:APPDATA\Code - Insiders\User\settings.json"

$targetPath = if (Test-Path $vscodeCfgPath) { $vscodeCfgPath }
              elseif (Test-Path $vscodeInsidersPath) { $vscodeInsidersPath }
              else { $vscodeCfgPath }

# Cria o arquivo se nao existir
if (-not (Test-Path $targetPath)) {
    New-Item -ItemType File -Path $targetPath -Force | Out-Null
    Set-Content $targetPath "{}" -Encoding UTF8
}

$settings = Get-Content $targetPath -Raw -Encoding UTF8 | ConvertFrom-Json

# Terminal settings
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.fontFamily"          -NotePropertyValue "CaskaydiaCove Nerd Font, Cascadia Code, Consolas, monospace"
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.fontSize"            -NotePropertyValue 14
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.lineHeight"          -NotePropertyValue 1.3
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.cursorStyle"         -NotePropertyValue "line"
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.cursorBlinking"      -NotePropertyValue $true
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.gpuAcceleration"     -NotePropertyValue "on"
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.defaultProfile.windows" -NotePropertyValue "PowerShell"
$settings | Add-Member -Force -NotePropertyName "terminal.integrated.minimumContrastRatio" -NotePropertyValue 1

# Editor font (mesma fonte com ligatures)
$settings | Add-Member -Force -NotePropertyName "editor.fontFamily"         -NotePropertyValue "CaskaydiaCove Nerd Font, Cascadia Code, Consolas, monospace"
$settings | Add-Member -Force -NotePropertyName "editor.fontSize"           -NotePropertyValue 14
$settings | Add-Member -Force -NotePropertyName "editor.fontLigatures"      -NotePropertyValue $true
$settings | Add-Member -Force -NotePropertyName "editor.lineHeight"         -NotePropertyValue 22
$settings | Add-Member -Force -NotePropertyName "editor.renderWhitespace"   -NotePropertyValue "boundary"
$settings | Add-Member -Force -NotePropertyName "editor.cursorBlinking"     -NotePropertyValue "smooth"
$settings | Add-Member -Force -NotePropertyName "editor.cursorSmoothCaretAnimation" -NotePropertyValue "on"

# UX
$settings | Add-Member -Force -NotePropertyName "workbench.startupEditor"           -NotePropertyValue "none"
$settings | Add-Member -Force -NotePropertyName "workbench.colorTheme"              -NotePropertyValue "One Dark Pro Darker"
$settings | Add-Member -Force -NotePropertyName "workbench.iconTheme"               -NotePropertyValue "material-icon-theme"
$settings | Add-Member -Force -NotePropertyName "workbench.tree.indent"             -NotePropertyValue 16
$settings | Add-Member -Force -NotePropertyName "explorer.compactFolders"           -NotePropertyValue $false
$settings | Add-Member -Force -NotePropertyName "breadcrumbs.enabled"               -NotePropertyValue $true
$settings | Add-Member -Force -NotePropertyName "editor.minimap.enabled"            -NotePropertyValue $false
$settings | Add-Member -Force -NotePropertyName "editor.stickyScroll.enabled"       -NotePropertyValue $true

$settings | ConvertTo-Json -Depth 10 | Set-Content $targetPath -Encoding UTF8
Write-Ok "VSCode settings.json atualizado"

# ── Extensoes VSCode ──────────────────────────────────────────────────────────
Write-Step "Instalando extensoes VSCode..."
$extensions = @(
    "zhuangtongfa.material-theme",        # One Dark Pro
    "PKief.material-icon-theme",           # Material Icons
    "eamodio.gitlens",                     # GitLens
    "ms-azuretools.vscode-docker",         # Docker
    "ms-kubernetes-tools.vscode-kubernetes-tools", # Kubernetes
    "humao.rest-client",                   # REST Client (como Postman no VSCode)
    "dbaeumer.vscode-eslint",              # ESLint
    "esbenp.prettier-vscode",             # Prettier
    "christian-kohler.path-intellisense",  # Path IntelliSense
    "usernamehw.errorlens"                 # Erros inline
)

foreach ($ext in $extensions) {
    code --install-extension $ext --force 2>$null
    Write-Ok $ext
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✓ Setup completo!" -ForegroundColor Green
Write-Host ""
Write-Host "  Proximos passos:" -ForegroundColor Cyan
Write-Host "  1. Feche e abra o VSCode"
Write-Host "  2. No terminal do VSCode: pressione Ctrl+Shift+P -> 'Select Default Profile' -> PowerShell"
Write-Host "  3. Feche o terminal (Ctrl+`) e abra novamente"
Write-Host "  4. Se a fonte nao aparecer: Ctrl+Shift+P -> 'Terminal: Select Default Profile'"
Write-Host ""
Write-Host "  Comandos rapidos disponiveis:" -ForegroundColor Cyan
Write-Host "  logs     -> cd Documents/logs"
Write-Host "  dup      -> docker compose up -d --build"
Write-Host "  dps      -> docker ps formatado"
Write-Host "  dlogs X  -> docker compose logs -f X"
Write-Host "  gs/ga/gc/gp -> git shortcuts"
Write-Host "  z <pasta>   -> navegar para pasta visitada recentemente"
Write-Host ""
