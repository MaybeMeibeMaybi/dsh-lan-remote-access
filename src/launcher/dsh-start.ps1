$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Log = Join-Path $env:TEMP ("dsh-launch-{0}.log" -f $stamp)
$StateDir = Join-Path $env:USERPROFILE '.dsh\lan'
$State = Join-Path $StateDir 'web-state.json'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$script:TestOnly = $env:DSH_LAUNCH_TEST -eq '1'
$script:Opened = $false

# Never launch the dsh shim: bare `dsh` resolves to dsh.ps1 (an ExternalScript)
# and Start-Process cannot run that ("not a valid Win32 application"). Always
# invoke the real entry point through node.exe.
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$DshBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

function Write-Log([string]$Text) {
    Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -ErrorAction SilentlyContinue
    Write-Host $Text
}

function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-GuiUrl {
    # dsh stores the launch token nowhere on disk: it prints it once, to stdout.
    # So the URL can only be recovered from a log some launcher wrote -- and logs
    # from dead instances linger, so every candidate token is validated against
    # the live server (a valid one answers 303) instead of trusting file order.
    $candidates = @($Log, (Join-Path $StateDir 'web.log'))
    $candidates += (Get-ChildItem (Join-Path $env:TEMP 'dsh*.log') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
    foreach ($c in $candidates) {
        if (-not $c -or -not (Test-Path $c)) { continue }
        $lines = Get-Content $c -ErrorAction SilentlyContinue |
            Where-Object { $_ -match 'token=[A-Za-z0-9_\-]{20,}' } | Select-Object -Last 1
        if (-not $lines -or -not ($lines -match '(https?://\S+)')) { continue }
        $url = $Matches[1].TrimEnd(')', ',')
        $status = & $NodeExe -e "try{const r=await fetch(process.argv[1],{redirect:'manual'});console.log(r.status)}catch(e){console.log('ERR')}" $url 2>&1 | Select-Object -Last 1
        if ("$status" -eq '303') { return $url }
    }
    return $null
}

function Open-Gui([string]$Reason) {
    if ($script:Opened) { return }
    $script:Opened = $true
    $url = Get-GuiUrl
    if (-not $url) {
        Write-Log '[launcher] no launch token found; check the dsh output for the URL.'
        return
    }
    if ($script:TestOnly) { Write-Host "[launcher] would open: $url" } else { Start-Process $url }
}

Write-Log ("launcher start (log: {0})" -f $Log)

if (Test-Port 3080) {
    Write-Log '[launcher] dsh web is already running - opening the UI (not starting a second server).'
    Open-Gui 'already-running'
    if (-not $script:TestOnly) { Start-Sleep -Seconds 2 }
    exit 0
}

Write-Log '[launcher] starting dsh web ...'
$argLine = '"' + $DshBin + '" web'
$p = Start-Process -FilePath $NodeExe -ArgumentList $argLine -WorkingDirectory $env:USERPROFILE `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $Log -RedirectStandardError ("{0}.err" -f $Log)

$deadline = (Get-Date).AddSeconds(90)
$guiUrl = $null
$sawBootstrapError = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if (-not $guiUrl) { $guiUrl = Get-GuiUrl }

    foreach ($f in @($Log, ("{0}.err" -f $Log))) {
        if (Test-Path $f) {
            $txt = Get-Content $f -Raw -ErrorAction SilentlyContinue
            if ($txt -match 'only the launching environment may set') { $sawBootstrapError = $true }
        }
    }
    if ($sawBootstrapError) { break }

    if ((Test-Port 3080) -and $guiUrl) {
        Write-Log '[launcher] dsh web is up.'
        # Persist the token for the LAN side so it need not re-derive it.
        $null = $guiUrl -match 'token=([A-Za-z0-9_\-]+)'
        $token = $Matches[1]
        @{ ok = $true; pid = $p.Id; token = $token; guiUrl = $guiUrl; startedAt = (Get-Date).ToString('s') } |
            ConvertTo-Json | Set-Content -Path $State -Encoding UTF8
        Open-Gui 'started'
        break
    }
    if ($p.HasExited) {
        Write-Log ("[launcher] dsh web exited with code {0} before the port opened." -f $p.ExitCode)
        break
    }
}

if ($sawBootstrapError) {
    Write-Log ''
    Write-Log '[launcher] dsh refused to start: a .env under your DSH home sets a bootstrap-only variable.'
    Write-Log ("           Fix: remove that line from {0}" -f (Join-Path $env:USERPROFILE '.dsh\.env'))
}
if (-not $script:Opened) { Write-Log '[launcher] the UI did not come up within 90s - see the log lines above.' }

# ------------------------------------------------- frpc watchdog (relay tunnel)
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI unless a BOM
# is present, so non-ASCII comments get mojibake'd and can break parsing.
# frpc is the public-relay client: it is started at logon by a Startup-folder
# entry, but nothing restarts it after a crash. This is an idempotent re-check:
# if it is already running, do nothing (never a second instance).
$RelayDir = 'E:\DSH\dsh-hiboard\relay'
$FrpcExe = Join-Path $RelayDir 'frpc.exe'
$FrpcCfg = Join-Path $RelayDir 'frpc.toml'
if ((Test-Path $FrpcExe) -and (Test-Path $FrpcCfg)) {
    if (Get-Process -Name 'frpc' -ErrorAction SilentlyContinue) {
        Write-Log '[launcher] frpc relay tunnel already running.'
    } else {
        Start-Process -FilePath $FrpcExe -ArgumentList '-c', "`"$FrpcCfg`"" -WorkingDirectory $RelayDir -WindowStyle Hidden
        Start-Sleep -Seconds 3
        if (Get-Process -Name 'frpc' -ErrorAction SilentlyContinue) {
            Write-Log '[launcher] frpc relay tunnel started.'
        } else {
            Write-Log '[launcher] frpc failed to start - see E:\DSH\dsh-hiboard\relay\frpc.log'
        }
    }
} else {
    Write-Log '[launcher] frpc.exe / frpc.toml not found - public relay unavailable (LAN still works).'
}
