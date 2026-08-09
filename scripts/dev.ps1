<#
  Builds and starts the whole stack for local development:
    - postgres + redis (docker-compose)
    - api server
    - consumer
    - web dashboard (vite dev server)

  Each Go service and the web dev server get their own console window so logs
  stay readable. Run from anywhere; paths are resolved relative to the repo root.

  Usage:
    scripts\dev.ps1            # build + start everything
    scripts\dev.ps1 -NoDocker  # skip docker-compose (postgres/redis already running)
#>

param(
    [switch]$NoDocker
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root

if (-not $NoDocker) {
    Write-Host "Starting postgres + redis..." -ForegroundColor Cyan
    docker-compose up -d
    if (-not $?) { throw "docker-compose up failed" }
}

Write-Host "Building api and consumer..." -ForegroundColor Cyan
go build -o bin/api.exe ./cmd/api
if (-not $?) { throw "build api failed" }
go build -o bin/consumer.exe ./cmd/consumer
if (-not $?) { throw "build consumer failed" }

Write-Host "Launching api..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; .\bin\api.exe" -WindowStyle Normal

Write-Host "Launching consumer..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; .\bin\consumer.exe" -WindowStyle Normal

Write-Host "Launching web dashboard..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\web'; npm run dev" -WindowStyle Normal

Write-Host "All services launched in separate windows (api, consumer, web)." -ForegroundColor Green
