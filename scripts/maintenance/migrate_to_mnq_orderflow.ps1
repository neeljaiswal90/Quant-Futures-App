<#
.SYNOPSIS
  Fresh-repo migration: D:\Quant-futures-app → D:\mnq-orderflow

.DESCRIPTION
  Phase 1 (non-destructive prep): clone + filter-repo + path renames + manual
  cleanups. Phase 2 (destructive cutover): stop live processes, swap data,
  re-register tasks, launch from new path. Each phase is run separately.

  Reads from the existing D:\Quant-futures-app\ at HEAD of whatever branch
  is currently checked out. Preserves dashboard-side commit history via
  git filter-repo. Drops algo-side paths entirely.

.PARAMETER Phase
  1 = non-destructive prep (clone + filter-repo + verify)
  2 = destructive cutover (stop live, swap data, register tasks, launch)
  3 = post-cutover validation

.PARAMETER DryRun
  Print the commands that would run but don't execute filter-repo or
  destructive moves.

.PARAMETER SourceRepo
  Source repo path. Default D:\Quant-futures-app.

.PARAMETER TargetRepo
  Destination repo path. Default D:\mnq-orderflow.

.EXAMPLE
  # Phase 1 prep — safe, runs while live system is up
  .\migrate_to_mnq_orderflow.ps1 -Phase 1 -DryRun
  .\migrate_to_mnq_orderflow.ps1 -Phase 1

  # Phase 2 cutover — destructive, run during market quiet window
  .\migrate_to_mnq_orderflow.ps1 -Phase 2

  # Phase 3 validation
  .\migrate_to_mnq_orderflow.ps1 -Phase 3
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(1, 2, 3)]
    [int]$Phase,
    [switch]$DryRun,
    [string]$SourceRepo = "D:\Quant-futures-app",
    [string]$TargetRepo = "D:\mnq-orderflow",
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe"
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message, [string]$Color = "Gray")
    Write-Host ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -ForegroundColor $Color
}

# ───────────────────────────────────────────────────────────────────────
# Path-include list for git filter-repo. Each path is a glob. Paths NOT
# in this list get DROPPED from the new repo's history. Curated from the
# A1 inventory CSV: docs/plan/repo-split-classification.csv.
# ───────────────────────────────────────────────────────────────────────
$PathsToKeep = @(
    # Apps — dashboard side only
    "apps/dashboard_ui/",
    "apps/dashboard_shell/",
    # Services — dashboard side only
    "services/realtime_backend/",
    "services/notification_daemon/",
    # Detector code lives in services/replay/replay/ in old repo; we'll
    # filter the WHOLE services/replay/ in (it's small) and prune algo-
    # specific files in the manual-cleanup step.
    "services/replay/",
    # Tools — dashboard side
    "tools/rithmic_analytics/",
    "tools/rithmic_dashboard/",
    # Contracts — shared schemas (will need clean up after filter-repo:
    # mypy_cache, algo-only contracts)
    "contracts/",
    # Scripts
    "scripts/launch_mnq_dashboard_shell.ps1",
    "scripts/infra/capture-rithmic-probe.py",
    "scripts/maintenance/",
    # Root launchers
    "Start-MNQ-Dashboard.cmd",
    "post_capture_rotate.ps1",
    "run_live_realtime_stack.ps1",
    "run_realtime_stack.ps1",
    # Docs — dashboard-relevant subset
    "docs/perf/",
    "docs/plan/repo-split-2026-06-03.md",
    "docs/plan/repo-split-coordinator-handoff.md",
    "docs/plan/repo-split-classification.csv",
    "docs/plan/repo-split-hardcoded-paths.csv",
    "docs/plan/dispose-candidates.md",
    "docs/plan/path-a-bookmap-heatmap.md",
    "docs/plan/codex-dispatch-bookmap-trade-dots-01.md",
    "docs/plan/codex-coordination-migration-pause-01.md",
    "docs/observability/",
    # Top-level config
    ".gitignore",
    ".gitattributes",
    ".env.example",
    "README.md",
    # tsconfig + package.json will need manual cleanup post-filter-repo
    # (strip operator_console workspace refs etc.); include them as-is here.
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.ts",
    "package.json",
    "package-lock.json"
)

# Paths to RENAME (filter-repo --path-rename)
# Format: "old/path:new/path"
$PathRenames = @(
    "tools/rithmic_analytics/:tools/rithmic_capture/",
    "services/replay/:services/detectors/"
)

# ───────────────────────────────────────────────────────────────────────
# Phase 1 — non-destructive prep
# ───────────────────────────────────────────────────────────────────────
if ($Phase -eq 1) {
    Write-Status "=== PHASE 1: non-destructive prep ===" Cyan

    Write-Status "Step 1: snapshot source repo (tag)" Yellow
    Push-Location $SourceRepo
    try {
        $sourceBranch = git symbolic-ref --short HEAD 2>$null
        if (-not $sourceBranch) { $sourceBranch = "(detached)" }
        $sourceTip = git rev-parse HEAD
        Write-Status "  source branch: $sourceBranch tip: $sourceTip" Gray
        $tag = "archive/pre-mnq-orderflow-2026-06-03"
        if (-not $DryRun) {
            git tag -f $tag
            Write-Status "  tagged $tag" Green
        } else {
            Write-Status "  DRY: would tag $tag" Gray
        }
    } finally { Pop-Location }

    Write-Status "Step 2: refuse to proceed if target already exists" Yellow
    if (Test-Path $TargetRepo) {
        throw "Target $TargetRepo already exists. Remove or rename before running Phase 1."
    }
    Write-Status "  target clear: $TargetRepo" Green

    Write-Status "Step 3: file-system clone" Yellow
    if (-not $DryRun) {
        git clone $SourceRepo $TargetRepo
        Write-Status "  cloned" Green
    } else {
        Write-Status "  DRY: would clone $SourceRepo -> $TargetRepo" Gray
    }

    Write-Status "Step 4: verify git-filter-repo is installed" Yellow
    $filterRepo = (Get-Command git-filter-repo -ErrorAction SilentlyContinue)
    if (-not $filterRepo) {
        Write-Status "  git-filter-repo NOT installed. Installing via pip..." Yellow
        if (-not $DryRun) {
            & $Python -m pip install git-filter-repo
        } else {
            Write-Status "  DRY: would pip install git-filter-repo" Gray
        }
    } else {
        Write-Status "  git-filter-repo present: $($filterRepo.Source)" Green
    }

    Write-Status "Step 5: run filter-repo with path-include + path-rename" Yellow
    Push-Location $TargetRepo
    try {
        $argList = @("--force")
        foreach ($p in $PathsToKeep) {
            $argList += "--path"
            $argList += $p
        }
        foreach ($r in $PathRenames) {
            $argList += "--path-rename"
            $argList += $r
        }
        Write-Status "  cmd: git filter-repo $($argList -join ' ')" Gray
        if (-not $DryRun) {
            & git filter-repo @argList
            if ($LASTEXITCODE -ne 0) { throw "filter-repo failed exit=$LASTEXITCODE" }
            Write-Status "  filter-repo done" Green
        } else {
            Write-Status "  DRY: would run filter-repo" Gray
        }
    } finally { Pop-Location }

    Write-Status "Step 6: size + branch verification" Yellow
    if (-not $DryRun) {
        $gitSize = (Get-ChildItem -Path "$TargetRepo\.git" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
        Write-Status "  new .git size: $([math]::Round($gitSize, 1)) MB (was ~7100 MB)" Green
        Push-Location $TargetRepo
        try {
            Write-Status "  branches:" Gray
            git branch -a | Select-Object -First 20
            Write-Status "  recent commits on current branch:" Gray
            git log --oneline -10
        } finally { Pop-Location }
    }

    Write-Status "Step 7: manual cleanup placeholders" Yellow
    Write-Status "  After Phase 1: hand-edit the following:" Gray
    Write-Status "    - package.json: remove apps/operator_console workspace refs" Gray
    Write-Status "    - tsconfig.json: regenerate references list" Gray
    Write-Status "    - contracts/: rm -rf .mypy_cache" Gray
    Write-Status "    - services/detectors/: prune algo-only files (keep setups.py + deps)" Gray
    Write-Status "    - README.md: rewrite for new project" Gray
    Write-Status "    - all D:\\Quant-futures-app references: replace with D:\\mnq-orderflow" Gray
    Write-Status "      (see docs/plan/repo-split-hardcoded-paths.csv for the 49 sites)" Gray

    Write-Status "=== PHASE 1 COMPLETE ===" Green
    Write-Status "Next: hand-edit cleanups, then `npm install && npm run build`. If green, ready for Phase 2." Cyan
}

# ───────────────────────────────────────────────────────────────────────
# Phase 2 — destructive cutover (run during market quiet window only)
# ───────────────────────────────────────────────────────────────────────
if ($Phase -eq 2) {
    Write-Status "=== PHASE 2: destructive cutover ===" Red
    Write-Status "This phase stops the live system. Only run during market quiet (14:00-17:00 PT today)." Yellow

    if (-not (Test-Path $TargetRepo)) {
        throw "Phase 1 hasn't run yet. Target $TargetRepo doesn't exist."
    }

    Write-Status "Step 1: stop live processes" Yellow
    foreach ($pattern in @('capture-rithmic-probe', 'realtime_backend', 'mnq-dashboard-shell', 'run_local_probe_refresh')) {
        $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern }
        foreach ($p in $procs) {
            Write-Status "  stopping $pattern pid=$($p.ProcessId)" Yellow
            if (-not $DryRun) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Start-Sleep -Seconds 3

    Write-Status "Step 2: move live data into new repo" Yellow
    $sourceData = Join-Path $SourceRepo "tools\rithmic_analytics\data"
    $targetData = Join-Path $TargetRepo "tools\rithmic_capture\data"
    if (Test-Path $sourceData) {
        if (-not $DryRun) {
            # Use robocopy /MIR so symlinks + permissions are sane on Windows
            robocopy $sourceData $targetData /MIR /NJH /NJS /NC /NDL /NP | Out-Null
            Write-Status "  data copied to $targetData" Green
        } else {
            Write-Status "  DRY: would robocopy $sourceData -> $targetData" Gray
        }
    }

    Write-Status "Step 3: re-register MNQ_* scheduled tasks at new paths" Yellow
    Write-Status "  (delete old, register new using powershell.exe not pwsh.exe)" Gray
    if (-not $DryRun) {
        $oldTasks = Get-ScheduledTask | Where-Object { $_.TaskName -like "MNQ_*" }
        foreach ($t in $oldTasks) {
            Write-Status "  deleting old task: $($t.TaskName)" Yellow
            schtasks /Delete /TN $t.TaskName /F 2>&1 | Out-Null
        }
        # Re-registration of tasks is a follow-up; left as manual step
        # because timing-of-day depends on operator preference.
        Write-Status "  re-registration is manual (operator schedules per their cadence)" Gray
    }

    Write-Status "Step 4: rename old repo to archive" Yellow
    $archivePath = "D:\_archive\Quant-futures-app-pre-mnq-orderflow-2026-06-03"
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path "D:\_archive" -Force | Out-Null
        Move-Item -Path $SourceRepo -Destination $archivePath
        Write-Status "  archived to $archivePath" Green
    }

    Write-Status "=== PHASE 2 COMPLETE ===" Green
    Write-Status "Next: launch from $TargetRepo\Start-MNQ-Dashboard.cmd" Cyan
}

# ───────────────────────────────────────────────────────────────────────
# Phase 3 — post-cutover validation
# ───────────────────────────────────────────────────────────────────────
if ($Phase -eq 3) {
    Write-Status "=== PHASE 3: validation ===" Cyan

    Push-Location $TargetRepo
    try {
        Write-Status "git status (should be clean):" Yellow
        git status

        Write-Status "TypeScript check:" Yellow
        Set-Location (Join-Path $TargetRepo "apps\dashboard_ui")
        npm run typecheck

        Write-Status "Tests:" Yellow
        npm run test -- --run

        Write-Status "Backend health:" Yellow
        try {
            (Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 5 -UseBasicParsing).Content
        } catch {
            Write-Status "backend not running — launch via Start-MNQ-Dashboard.cmd first" Yellow
        }
    } finally { Pop-Location }

    Write-Status "=== PHASE 3 COMPLETE ===" Green
}
