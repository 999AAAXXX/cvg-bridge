@echo off
chcp 65001 >nul
title 反代本地
cd /d %~dp0

set "PORT=8097"
set "GROUPLINK=https://qm.qq.com/q/NBX5cnLfIC"

echo ============================================
echo   反代本地  ·  一键启动
echo   QQ 群: 1130166963
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18 或更高版本: https://nodejs.org/
  pause
  exit /b 1
)

rem 端口已被占用则不再启动第二个实例
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo [提示] 端口 %PORT% 已在运行，直接打开界面
) else (
  echo [启动] 正在启动服务 ...
  start "反代本地服务" cmd /c "node server.js"
  timeout /t 2 >nul
)

echo [打开] http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
echo [打开] 交流群 %GROUPLINK%
start "" "%GROUPLINK%"

echo.
echo 服务已就绪。关闭本窗口不会停止服务（服务在独立窗口）。
echo.
pause
