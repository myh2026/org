# org — Windows 启动器（PowerShell）
# 用法：bin\org.ps1 <command> [args]
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $PSScriptRoot
& bun (Join-Path $Dir "cli\org.ts") @args
exit $LASTEXITCODE
