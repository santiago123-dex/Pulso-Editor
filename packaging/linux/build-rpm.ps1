# Genera el .rpm de Pulso Editor para Fedora usando Docker (no hace falta tener Linux).
# Uso, desde la raíz del repositorio:  .\packaging\linux\build-rpm.ps1
# El paquete queda en dist-linux\. La primera vez tarda bastante (descarga Fedora y compila todo); las siguientes reutilizan capas.
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker no está en marcha. Abre Docker Desktop y vuelve a intentarlo." }
if (Test-Path dist-linux) { Remove-Item dist-linux -Recurse -Force }
docker build -f packaging/linux/Dockerfile --target out --output type=local,dest=dist-linux .
if ($LASTEXITCODE -ne 0) { throw "La compilación falló." }
Get-ChildItem dist-linux | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,1)}}
