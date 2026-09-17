@echo off
cd /d D:\Project\6pro-agent

netstat -ano | findstr :17888 >nul
if %errorlevel% neq 0 (
  start "" /B "C:\Users\13914\.codex-chatgpt-web\versions\5.0.8-win32-x64\runtime\bun.exe" server.js
  timeout /t 1 /nobreak >nul
)

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:17888 --window-size=1100,780
