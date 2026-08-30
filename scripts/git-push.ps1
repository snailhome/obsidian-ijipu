<#
.SYNOPSIS  obsidian-ijipu 一键推送 (PowerShell，中文友好)
#>
[CmdletBinding()]
param(
  [string]$RemoteUrl = "git@github.com:snailhome/obsidian-ijipu.git",
  [string]$Token = "",
  [string]$Branch = "main",
  [string]$Tag = "",
  [switch]$SkipMain,
  [string]$CommitMsg = ""
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot
Write-Host "== 仓库：$RepoRoot ==" -ForegroundColor Cyan
git remote -v
Write-Host "`n== git status ==" -ForegroundColor Cyan
git status --short
if (git status --short) {
  if (-not $CommitMsg) {
    if ($Tag) { $CommitMsg = "chore: release $Tag" } else { $CommitMsg = "chore: update" }
  }
  Write-Host "`n== commit: $CommitMsg ==" -ForegroundColor Cyan
  git add -A
  git commit -m "$CommitMsg" 2>&1 | Select-Object -Last 3
} else { Write-Host "`n== 无改动可提交，跳过 commit ==" -ForegroundColor DarkGray }
if (-not $SkipMain) {
  Write-Host "`n== push origin $Branch ==" -ForegroundColor Cyan
  if ($Token -and $RemoteUrl.StartsWith("https://")) {
    $rp = ($RemoteUrl -replace "^https://github.com/","" -replace "\.git$","")
    git push "https://${Token}@github.com/${rp}.git" $Branch
  } else { git push origin $Branch }
} else { Write-Host "`n== 跳过 push main ==" -ForegroundColor DarkGray }
if ($Tag) {
  Write-Host "`n== tag $Tag ==" -ForegroundColor Cyan
  git tag -d $Tag 2>$null | Out-Null
  git push origin ":refs/tags/$Tag" 2>$null | Out-Null
  git tag $Tag
  if ($Token -and $RemoteUrl.StartsWith("https://")) {
    $rp = ($RemoteUrl -replace "^https://github.com/","" -replace "\.git$","")
    git push "https://${Token}@github.com/${rp}.git" $Tag
  } else { git push origin $Tag }
} else { Write-Host "`n== 未指定 -Tag ==" -ForegroundColor DarkGray }
Write-Host "`n== 完成 ==" -ForegroundColor Green
Write-Host "Actions:  https://github.com/snailhome/obsidian-ijipu/actions"
Write-Host "Release: https://github.com/snailhome/obsidian-ijipu/releases"