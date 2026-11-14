@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
python launch.py
if errorlevel 1 (
  echo.
  echo 启动遇到问题。请确认电脑已安装 Python 3.11 或以上版本，再查看使用说明。
  pause
)
endlocal
