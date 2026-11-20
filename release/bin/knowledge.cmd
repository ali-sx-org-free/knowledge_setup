@echo off
rem knowledge_setup launcher for Windows: forwards to knowledge.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0knowledge.ps1" %*
exit /b %ERRORLEVEL%
