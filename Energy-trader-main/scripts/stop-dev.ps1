# Stops typical dev listeners for this project (Windows PowerShell).
# Run from repo root: npm run stop:dev
# Requires permission to stop processes you own (no admin usually needed).

$ErrorActionPreference = "SilentlyContinue"
$ports = @(3000, 3001, 8000, 8002, 8545)

foreach ($port in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pid in $pids) {
    if ($pid -gt 0) {
      Write-Host "Stopping PID $pid (port $port)"
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Done. Ports cleared: $($ports -join ', ')"
