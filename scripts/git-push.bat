@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  obsidian-ijipu 一键推送脚本（cmd batch）
REM  用法：
REM    scripts\git-push.bat                       只 push main
REM    scripts\git-push.bat 0.2.0                 push main + 打 tag 触发 CI Release
REM    scripts\git-push.bat 0.2.0 SSH             自定义 remote（默认 SSH）
REM    scripts\git-push.bat 0.2.0 HTTPS URL       自定义 remote（HTTPS，不带 token）
REM ============================================================

REM 切到仓库根（脚本在 scripts/，向上退一级）
cd /d "%~dp0.."

REM 参数
set "TAG=%~1"
set "REMOTE_URL=%~2"
if "%REMOTE_URL%"=="" set "REMOTE_URL=git@github.com:snailhome/obsidian-ijipu.git"
set "BRANCH=main"

echo === 仓库：%cd% ===
git remote -v

REM 若 origin 不存在则添加
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo === 添加 origin: %REMOTE_URL% ===
    git remote add origin "%REMOTE_URL%"
)

echo === git status ===
git status --short

echo === add ===
git add -A

REM 若有 staged 改动则 commit
git diff --cached --quiet
if not errorlevel 1 (
    if "!TAG!"=="" (
        set "MSG=chore: update"
    ) else (
        set "MSG=chore: release !TAG!"
    )
    echo === commit: !MSG! ===
    git commit -m "!MSG!"
) else (
    echo === 无 staged 改动，跳过 commit ===
)

echo === push origin %BRANCH% ===
git push origin %BRANCH%
if errorlevel 1 (
    echo !!! push main 失败，请检查 remote / 权限 !!!
    exit /b 1
)

REM 打 tag 并推送（如指定 Tag）
if not "%TAG%"=="" (
    echo === tag !TAG! ===
    git tag -d !TAG! 2>nul
    git push origin :refs/tags/!TAG! 2>nul
    git tag !TAG!
    echo === push tag !TAG! ===
    git push origin !TAG!
    if errorlevel 1 (
        echo !!! push tag 失败 !!!
        exit /b 1
    )
)

echo.
echo === 完成 ===
echo Actions:   https://github.com/snailhome/obsidian-ijipu/actions
echo Releases:  https://github.com/snailhome/obsidian-ijipu/releases
