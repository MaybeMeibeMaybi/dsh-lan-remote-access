@echo off
REM ===========================================================================
REM Desktop launcher for the dsh web GUI - the ONLY file that should live here.
REM
REM - If dsh web is already running: just opens the UI. Never starts a second
REM   instance (that only causes EADDRINUSE).
REM - If it is not running: starts it via node.exe + bin.js, waits for the port,
REM   then opens the URL carrying the current session token.
REM - Keeps the window open at the end so failures are visible, never silent.
REM - Also makes sure the frpc relay tunnel is running (idempotent check).
REM
REM Docs and troubleshooting: E:\DSH\dsh-hiboard\README.md
REM Log: %TEMP%\dsh-launch-<timestamp>.log
REM
REM NOTE: keep this file ASCII-only. cmd.exe decodes .cmd using the system ANSI
REM code page (GBK on Chinese Windows), so UTF-8 text becomes mojibake and the
REM leading REM gets eaten - the garbage is then executed as commands.
REM ===========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\DSH\dsh-hiboard\dsh-start.ps1"
echo.
echo ---- launcher finished. Docs: E:\DSH\dsh-hiboard\README.md ----
pause
