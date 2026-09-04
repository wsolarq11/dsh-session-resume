[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$Commit,
    [switch]$Push,
    [switch]$ForceTag
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments)
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $FilePath $($Arguments -join ' ')"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Join-Path $repoRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "Missing package.json: $packageJson"
}
$package = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $package.version
}

$distDir = Join-Path $repoRoot 'dist'
$tgzName = 'dsh-external-dsh-session-resume-{0}.tgz' -f $Version
$tgzPath = Join-Path $distDir $tgzName

Write-Host "==> Building $($package.name) $Version"
Invoke-Native -FilePath 'npm' -Arguments @('run', 'build')

New-Item -ItemType Directory -Path $distDir -Force | Out-Null
Invoke-Native -FilePath 'npm' -Arguments @('pack', '--ignore-scripts', '--pack-destination', $distDir)

if (-not (Test-Path -LiteralPath $tgzPath)) {
    $packed = Get-ChildItem -LiteralPath $distDir -Filter '*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $packed) {
        throw "npm pack produced no tarball"
    }
    throw "Unexpected tarball name: $($packed.Name), expected $tgzName"
}

$listing = & tar -tzf $tgzPath --force-local
if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect $tgzPath"
}
if (-not ($listing -match '(^|/)package/lib/index\.js$')) {
    throw "Release tarball is missing package/lib/index.js"
}
if (-not ($listing -match '(^|/)package/lib/client\.js$')) {
    throw "Release tarball is missing package/lib/client.js"
}

Write-Host "==> Release artifact ready: $tgzPath"
$hash = (Get-FileHash -LiteralPath $tgzPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "    SHA256 $hash"

if ($Commit) {
    Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'add', '.gitignore', 'dist', 'scripts/release.ps1', 'package.json', 'package-lock.json')
    Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'commit', '--allow-empty', '-m', "Release $Version prebuilt artifact")
    $tag = 'v' + $Version
    if ($ForceTag) {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'tag', '--force', $tag)
    }
    else {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'tag', $tag)
    }
    Write-Host "==> Tagged $tag"
}

if ($Push) {
    Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'push', 'origin', 'HEAD')
    if ($ForceTag) {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'push', '--force', 'origin', ('v' + $Version))
    }
    else {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $repoRoot, 'push', 'origin', ('v' + $Version))
    }
    Write-Host "==> Pushed $('v' + $Version) to origin"
}
