# quickstart.ps1 — setup completo apos git clone
# Uso: .\scripts\quickstart.ps1
# Ou com teste de carga: .\scripts\quickstart.ps1 -RunTest

param([switch]$RunTest)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "    [OK] $msg" -ForegroundColor Green
}

function Write-Fail([string]$msg) {
    Write-Host "    [ERRO] $msg" -ForegroundColor Red
    exit 1
}

# ── 1. Pre-requisitos ─────────────────────────────────────────────────────────
Write-Step "Verificando pre-requisitos..."

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "Docker nao encontrado. Instale Docker Desktop: https://docs.docker.com/desktop/windows/"
}
Write-Ok "Docker: $(docker --version)"

$dockerRunning = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker Desktop nao esta rodando. Abra o Docker Desktop e tente novamente."
}
Write-Ok "Docker Desktop: rodando"

# ── 2. Subir ambiente ─────────────────────────────────────────────────────────
Write-Step "Subindo todos os containers (build + start)..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Fail "docker compose up falhou" }

# ── 3. Aguardar servicos ──────────────────────────────────────────────────────
Write-Step "Aguardando servicos ficarem prontos..."

$services = @(
    @{ name = "Kafka";      url = $null;                      container = "logs-kafka-1" },
    @{ name = "ClickHouse"; url = "http://localhost:8123/ping"; container = $null },
    @{ name = "user-service";  url = "http://localhost:3001/health"; container = $null },
    @{ name = "watch-service"; url = "http://localhost:3002/health"; container = $null },
    @{ name = "like-service";  url = "http://localhost:3003/health"; container = $null }
)

$maxWait = 90
$waited = 0

foreach ($svc in $services) {
    $ready = $false
    Write-Host "    Aguardando $($svc.name)..." -NoNewline

    while (-not $ready -and $waited -lt $maxWait) {
        Start-Sleep -Seconds 2
        $waited += 2

        if ($svc.url) {
            try {
                $resp = Invoke-WebRequest -Uri $svc.url -TimeoutSec 2 -ErrorAction Stop
                $ready = ($resp.StatusCode -lt 400)
            } catch { $ready = $false }
        } elseif ($svc.container) {
            $status = docker inspect --format "{{.State.Health.Status}}" $svc.container 2>$null
            $ready = ($status -eq "healthy")
        }

        Write-Host "." -NoNewline
    }

    if ($ready) { Write-Host " OK" -ForegroundColor Green }
    else { Write-Host " TIMEOUT" -ForegroundColor Yellow }
}

# ── 4. Seed de dados ──────────────────────────────────────────────────────────
Write-Step "Criando dados de exemplo..."

$user = Invoke-RestMethod -Method Post -Uri "http://localhost:3001/users" `
    -ContentType "application/json" `
    -Body '{"name":"Dev Teste","email":"dev@streaming.test"}'

$userId = $user.id
Write-Ok "Usuario criado: $userId"

$movies = @("11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222","33333333-3333-3333-3333-333333333333")
foreach ($movie in $movies) {
    Invoke-RestMethod -Method Post -Uri "http://localhost:3002/watch" `
        -ContentType "application/json" `
        -Body "{`"user_id`":`"$userId`",`"movie_id`":`"$movie`",`"duration_seconds`":3600}" | Out-Null
    Invoke-RestMethod -Method Post -Uri "http://localhost:3003/likes" `
        -ContentType "application/json" `
        -Body "{`"user_id`":`"$userId`",`"movie_id`":`"$movie`"}" | Out-Null
}

Invoke-RestMethod -Method Post -Uri "http://localhost:3004/subscriptions" `
    -ContentType "application/json" `
    -Body "{`"user_id`":`"$userId`",`"plan`":`"premium`",`"card_token`":`"tok_visa`"}" | Out-Null

Write-Ok "Eventos gerados (watch, like, subscription)"

Start-Sleep -Seconds 5

# ── 5. Verificar ClickHouse ───────────────────────────────────────────────────
Write-Step "Verificando dados no ClickHouse..."

$query = "SELECT ms_name, operation, count() as total FROM logs.events GROUP BY ms_name, operation ORDER BY total DESC FORMAT TSV"
$result = docker compose exec clickhouse clickhouse-client `
    --user streaming --password streaming `
    --query $query 2>&1

if ($result) {
    Write-Ok "ClickHouse com dados:"
    $result | ForEach-Object { Write-Host "    $_" }
} else {
    Write-Host "    ClickHouse ainda sem dados (aguarde e rode make ch-query)" -ForegroundColor Yellow
}

# ── 6. URLs ───────────────────────────────────────────────────────────────────
Write-Step "Ambiente pronto!"
Write-Host ""
Write-Host "  Grafana (dashboards): " -NoNewline; Write-Host "http://localhost:3000  (admin/admin)" -ForegroundColor Yellow
Write-Host "  Kafka UI:             " -NoNewline; Write-Host "http://localhost:8080" -ForegroundColor Yellow
Write-Host "  Jaeger (traces):      " -NoNewline; Write-Host "http://localhost:16686" -ForegroundColor Yellow
Write-Host "  Prometheus:           " -NoNewline; Write-Host "http://localhost:9090" -ForegroundColor Yellow
Write-Host "  MinIO (cold storage): " -NoNewline; Write-Host "http://localhost:9011  (streaming/streaming123)" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Comandos uteis:" -ForegroundColor Cyan
Write-Host "    make test-load     — load test (50 VUs, 5 min)"
Write-Host "    make test-stress   — stress test (ate 200 VUs)"
Write-Host "    make ch-query      — ver eventos no ClickHouse"
Write-Host "    make health        — saude dos servicos"
Write-Host "    make logs          — logs de todos os containers"
Write-Host ""

# ── 7. Teste de carga opcional ────────────────────────────────────────────────
if ($RunTest) {
    Write-Step "Rodando load test (50 VUs, 5 minutos)..."
    & "$PSScriptRoot\k6-run.ps1" "load-test.js"
}
