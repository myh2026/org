@echo off
REM org — Windows 启动器（cmd）
REM 用法：bin\org.cmd <command> [args]
setlocal
set "DIR=%~dp0.."
bun "%DIR%\cli\org.ts" %*
exit /b %ERRORLEVEL%
