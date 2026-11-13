@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    python serve.py
) else (
    echo 未检测到 Python 3，改用直接打开 index.html（模型会加载内联副本）。
    start "" "%~dp0index.html"
    pause
)
