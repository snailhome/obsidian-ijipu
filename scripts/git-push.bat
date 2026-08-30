@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  obsidian-ijipu one-click push script (cmd batch, ASCII safe)
REM  Usage:
REM    scripts\git-push.bat                       push main only
REM    scripts\git-push.bat 0.2.0                 push main + tag 0.2.0 (triggers CI Release)
REM    scripts\git-push.bat 0.2.0 https://...      custom remote (HTTPS, no token)
REM ============================================================

REM  cd to repo root (script lives in scripts/, go up one level)
cd /d "%~dp0.."

REM  Args: %1 = Tag (optional), %2 = RemoteUrl (optional)
set "TAG=%~1"
set "REMOTE_URL=%~2"
if "%REMOTE_URL%"=="" set "REMOTE_URL=git@github.com:snailhome/obsidian-ijipu.git"
set "BRANCH=main"

echo === Repo: %cd% ===
git remote -v

REM  Add origin if not set
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo === Adding origin: %REMOTE_URL% ===
    git remote add origin "%REMOTE_URL%"
)

echo === git status ===
git status --short

echo === git add ===
git add -A

REM  Commit if there are staged changes
git diff --cached --quiet
if not errorlevel 1 (
    if "!TAG!"=="" (
        set "MSG=chore: update"
    ) else (
        set "MSG=chore: release !TAG!"
    )
    echo === Commit: !MSG! ===
    git commit -m "!MSG!"
) else (
    echo === No staged changes, skip commit ===
)

echo === Push origin %BRANCH% ===
git push origin %BRANCH%
if errorlevel 1 (
    echo !!! push main FAILED, check remote / permissions !!!
    exit /b 1
)

REM  Tag + push tag (if Tag specified)
if not "%TAG%"=="" (
    echo === Tag !TAG! ===
    git tag -d !TAG! 2>nul
    git push origin :refs/tags/!TAG! 2>nul
    git tag !TAG!
    echo === Push tag !TAG! ===
    git push origin !TAG!
    if errorlevel 1 (
        echo !!! push tag FAILED !!!
        exit /b 1
    )
)

echo.
echo === Done ===
echo Actions:   https://github.com/snailhome/obsidian-ijipu/actions
echo Releases:  https://github.com/snailhome/obsidian-ijipu/releases