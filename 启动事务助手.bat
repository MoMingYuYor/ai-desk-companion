@echo off
chcp 65001 >nul
title 事务助手 - 本地启动
cd /d "%~dp0"

if not exist node_modules (
  echo [首次运行] 正在安装依赖,请耐心等待...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败,请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动事务助手...
echo 提示:请通过托盘菜单"退出应用"正常退出;直接关闭本窗口会强制结束程序。
call npm run dev
