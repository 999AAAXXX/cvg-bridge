@echo off
chcp 65001 >nul
title 反代本地 · 续期
cd /d %~dp0
echo 用法示例：
echo    python renew-cookie.py --file cookies.json --headed --push
echo.
python renew-cookie.py %*
pause
