@echo off
rem Lanza el widget y cierra esta consola enseguida
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
