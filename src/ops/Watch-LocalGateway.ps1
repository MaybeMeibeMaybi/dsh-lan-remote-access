# ============================================================================
# Watch-LocalGateway.ps1 - watchdog + evidence recorder for the tailnet-local
# "no token" gateway (100.x:8443).
#
# Why it exists (2026-09-30):
#   The 8443 gateway was NOT running and nothing anywhere said why: dsh plugin
#   logs never hit disk, the supervisor log had no new line, and there was no
#   process left to inspect. "Did anything try to start it?" was unanswerable.
#   So this watcher records, every cycle, four facts:
#     - the tailnet address (empty when Tailscale is down / logged out)
#     - whether 8443 is listening (and which pid owns the listener)
#     - whether the supervisor process (Start-LocalGateway.ps1) exists
#     - the gateway health probe result (/__gw_health, self-signed cert accepted)
#   and it self-heals: when the tailnet is up but nothing serves 8443 AND no
#   supervisor exists, it starts the supervisor and records what happened next.
#
# The FIRST cycle line is the one that matters after a reboot: it states whether
# the gateway was already up BEFORE this watcher touched anything - i.e. whether
# dsh-entry-startup did its job. The first cycle never auto-starts, so the record
# stays honest.
#
# Outputs:
#   %USERPROFILE%\.dsh\lan\local-gateway-watch.log   (append-only, transitions)
#   %USERPROFILE%\.dsh\lan\local-gateway-watch.json  (latest state, one object)
#
# Implementation notes (both learned the hard way):
#   * The health probe shells out to curl.exe -k. A PowerShell *scriptblock*
#     certificate callback does NOT work from a hidden spawned process: the TLS
#     callback thread has no runspace, so the probe failed (health=-1) while the
#     gateway was answering 200. Add-Type + ICertificatePolicy works but costs a
#     CodeDom compile on every start; curl.exe is simpler and needs neither.
#   * "watcher started" is logged BEFORE any probing, so a process that dies or
#     hangs later still leaves proof that it ran at all.
#
# ASCII-only on purpose: PowerShell 5.1 decodes .ps1 as ANSI when there is no BOM.
# ============================================================================
[CmdletBinding()]
param(
    [int]$Port = 8443,
    [int]$IntervalSeconds = 30,
    [int]$StartupGraceSeconds = 25,
    [int]$CardGraceSeconds = 45,
    [string]$SupervisorScript = 'E:\DSH\dsh-tunnel\Start-LocalGateway.ps1',
    [switch]$Once,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Continue'
$stateDir = Join-Path $env:USERPROFILE '.dsh\lan'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir 'local-gateway-watch.log'
$stateFile = Join-Path $stateDir 'local-gateway-watch.json'
$lockFile = Join-Path $stateDir 'local-gateway-watch.lock'

function Write-Log([string]$m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $log -Value $line -ErrorAction SilentlyContinue
    Write-Host $line
}

# ---------------------------------------------------------------- single instance
# Two watchers would double-log and could race on starting the supervisor, so a
# pid lock file keeps exactly one. A stale lock (dead pid) is taken over.
if (Test-Path $lockFile) {
    $old = (Get-Content $lockFile -Raw -ErrorAction SilentlyContinue)
    if ($old) { $old = $old.Trim() }
    if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) {
        Write-Log "another watcher is already running (pid $old) - exiting"
        exit 0
    }
    Write-Log "stale lock (pid $old not running) - taking over"
}
Set-Content -Path $lockFile -Value $PID -Encoding ASCII

# Logged before any probing on purpose: proof of life even if a later step hangs.
Write-Log ("watcher started (pid {0}, port {1}, interval {2}s, autoStart {3})" -f $PID, $Port, $IntervalSeconds, (-not $NoAutoStart))

# ---------------------------------------------------------------- probes
$script:CurlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $script:CurlExe) { Write-Log "curl.exe not found - health probe disabled (listening/process checks still work)" }

function Get-TailnetIp {
    $candidate = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '100.*' -and $_.InterfaceAlias -like '*Tailscale*' } |
        Select-Object -First 1
    if ($candidate) { return $candidate.IPAddress }
    $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' } |
        Select-Object -First 1
    if ($fallback) { return $fallback.IPAddress }
    return ''
}

function Test-Listening([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Get-ListeningPid([int]$p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
    return 0
}

# The supervisor is a powershell.exe whose command line names the script. Exclude
# this watcher's own pid. Note that any *ad-hoc diagnostic* command that merely
# mentions the script name in its text will also match - that trap produced two
# phantom "watch" processes during the 2026-09-30 investigation.
function Get-GatewaySupervisor {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*Start-LocalGateway.ps1*' -and $_.ProcessId -ne $PID }
    return @($procs) | Select-Object -First 1
}

function Test-GatewayHealth([string]$ip) {
    if (-not $ip -or -not $script:CurlExe) { return -1 }
    try {
        $code = & $script:CurlExe -k -s -o NUL -w "%{http_code}" --max-time 6 ("https://{0}:{1}/__gw_health" -f $ip, $Port) 2>$null
        if ("$code" -match '^\d+$') { return [int]$code }
        return -1
    } catch {
        return -1
    }
}

function Write-State($obj) {
    try { $obj | ConvertTo-Json -Compress | Set-Content -Path $stateFile -Encoding UTF8 } catch { }
}

# ============================================================================
# Card delivery watchdog (added 2026-09-30).
#
# Why here: the token card is the phone's ONLY way to get the current address and
# token, and the in-dsh plugin push proved unreliable - dsh's own process got
# `404 {"message":"Not Found"}` from the HUAWEI endpoint for minutes on end while
# the *same bytes* sent from a fresh process returned 200. Rather than keep
# guessing why, this watcher (which runs OUTSIDE dsh, started by the restart
# script / at boot) checks whether the current startup's card was ever delivered
# and, if not, sends it itself through lib/push-once.mjs - a fresh process, the
# path that demonstrably works.
#
# It only acts when the card is missing, so a healthy startup produces no extra
# cards. Delivery is judged by cards.jsonl: a success line whose tokenTail matches
# web-state.json's token.
# ============================================================================
$script:CardPusher = 'E:\DSH\dsh-token-broadcast\lib\push-once.mjs'
$script:CardAudit = Join-Path $env:USERPROFILE '.dsh\lan\token-broadcast\cards.jsonl'
$script:StateJson = Join-Path $env:USERPROFILE '.dsh\lan\web-state.json'
$script:PatchYml = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'

function Test-CardDelivered([string]$token) {
    if (-not $token -or -not (Test-Path $script:CardAudit)) { return $false }
    $tail = $token.Substring([Math]::Max(0, $token.Length - 8))
    foreach ($line in (Get-Content $script:CardAudit -Tail 60 -ErrorAction SilentlyContinue)) {
        if ($line -like '*"ok":true*' -and $line -like ('*' + $tail + '*')) { return $true }
    }
    return $false
}

function Send-TokenCard {
    # All Chinese card text lives in Push-TokenCard.mjs (UTF-8, read by node) -
    # this .ps1 must stay pure ASCII, so it only calls and parses the result.
    $pusher = 'E:\DSH\dsh-tunnel\Push-TokenCard.mjs'
    if (-not (Test-Path $pusher)) { return 'pusher-missing' }
    $node = 'C:\Program Files\nodejs\node.exe'
    if (-not (Test-Path $node)) { $node = 'node' }
    try {
        $out = (& $node $pusher 2>&1 | Out-String).Trim()
    } catch {
        $out = "helper-error: $($_.Exception.Message)"
    }
    if ($out -like '*"ok":true*') { return 'pushed' }
    return ('push-failed: ' + $out)
}

# Detects the "dsh was started WITHOUT the launcher" failure mode (2026-09-30 13:38).
# The launcher (dsh-start.ps1) is the only component that captures dsh's one-time
# session token and writes ~/.dsh/lan/web-state.json. If dsh was started any other
# way (e.g. the old desktop dsh.bat that ran `dsh web` directly), that file keeps the
# PREVIOUS startup's token: nobody can push a card, nobody can register the gateways,
# and every remote entry dies while looking perfectly healthy otherwise.
function Test-LauncherBypass {
    if (-not (Test-Path $script:StateJson)) { return '' }
    $statePid = 0
    try { $statePid = [int](Get-Content $script:StateJson -Raw | ConvertFrom-Json).pid } catch { return '' }
    $live = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $live) { return '' }
    if ($statePid -eq [int]$live.OwningProcess) { return '' }
    return ("web-state pid {0} != live dsh pid {1}" -f $statePid, $live.OwningProcess)
}

# Is web-state.json the CURRENT startup's file? (The pid that wrote it must be the live dsh
# process listening on 3080.) Added 2026-10-02, after the 23:05 `dsh web` boot: the file still
# held the PREVIOUS launcher startup's token, so Test-CardDelivered matched an OLD audit line
# (cardDelivered=true - a false positive) and a fallback push would have sent the phone a card
# carrying a DEAD token. "Stale state file" means nobody knows this startup's token; the honest
# thing is to say so, never to push the previous token.
function Test-StateFresh {
    if (-not (Test-Path $script:StateJson)) { return $false }
    $statePid = 0
    try { $statePid = [int](Get-Content $script:StateJson -Raw | ConvertFrom-Json).pid } catch { return $false }
    if (-not $statePid) { return $false }
    $live = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $live) { return $false }
    return ($statePid -eq [int]$live.OwningProcess)
}

# ============================================================================
# LAN entry self-check (added 2026-09-30).
#
# User report: the LAN URL from the card opened "dsh web authentication required;
# reopen the URL printed by dsh web". Reproduced from this machine only when the
# token in the URL is stale (an older card) - with the CURRENT token every cookie
# scenario ends at the GUI. So this watcher now proves, every cycle, that the LAN
# entry works with the token of THIS startup:
#   GET http://<lan-ip>:3081/?token=<current>  -> expect 303 (session bootstrap)
#   follow to /                               -> expect 200 and a real GUI page
# A failure is logged (and lands in the state file) so "the card's LAN link is
# dead" never again has to be discovered by the user.
# ============================================================================
function Test-LanEntry {
    if (-not $script:CurlExe -or -not (Test-Path $script:StateJson)) { return 'unknown' }    $token = ''
    try { $token = [string](Get-Content $script:StateJson -Raw | ConvertFrom-Json).token } catch { }
    if (-not $token) { return 'no-token' }
    $lan = ''
    $c = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1
    if ($c) { $lan = $c.IPAddress }
    if (-not $lan) { return 'no-lan-ip' }
    $page = Join-Path $env:TEMP ('dsh-lan-check-{0}.html' -f $PID)
    $jar = Join-Path $env:TEMP ('dsh-lan-jar-{0}.txt' -f $PID)
    Remove-Item $jar -ErrorAction SilentlyContinue
    # Browser-ish UA on purpose: the proxy serves a same-site handoff page to browsers
    # (SameSite=Strict fix), so a browser test must include that hop with ?hs=1.
    $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    try {
        $first = & $script:CurlExe -s -o NUL -w "%{http_code}" --max-time 8 ("http://{0}:3081/?token={1}" -f $lan, $token) 2>$null
        # -c/-b jar is REQUIRED: without a cookie jar curl drops the session cookie and
        # every follow-up looks like a 401 (that false alarm fired once on 2026-09-30).
        $final = & $script:CurlExe -s -L -c $jar -b $jar -A $ua -o $page -w "%{http_code}" --max-time 12 ("http://{0}:3081/?token={1}&hs=1" -f $lan, $token) 2>$null
        $len = 0
        $body = ''
        if (Test-Path $page) {
            $len = (Get-Item $page).Length
            if ($len -lt 200000) { $body = Get-Content $page -Raw -ErrorAction SilentlyContinue }
        }
        $verdict = 'ok'
        if ("$first" -ne '303' -and "$first" -ne '200') { $verdict = "bad-bootstrap(HTTP $first)" }
        elseif ("$final" -ne '200') { $verdict = "bad-final(HTTP $final)" }
        elseif ($body -and $body -match 'authentication required') { $verdict = 'auth-required' }
        elseif ($len -lt 3000) { $verdict = "tiny-page($len bytes)" }
        return ("{0} {1}/{2} {3}b" -f $verdict, $first, $final, $len)
    } catch {
        return ('probe-error: ' + $_.Exception.Message)
    } finally {
        Remove-Item $page, $jar -ErrorAction SilentlyContinue
    }
}

# trustedHosts drift check (added 2026-09-30): DHCP moved this PC from .104 to# .106 and the LAN entry looked "logged out" (the /api fence returned 403) while
# the patch file still listed the old address. This watcher only REPORTS the
# drift - it deliberately does not rewrite cordis.patch.yml, because writing that
# file while dsh runs has now twice been followed by a dsh restart/crash.
function Test-TrustedHostDrift {
    $c = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1
    if (-not $c -or -not (Test-Path $script:PatchYml)) { return '' }
    $txt = Get-Content $script:PatchYml -Raw -ErrorAction SilentlyContinue
    if ($txt -like ('*' + $c.IPAddress + '*')) { return '' }
    return $c.IPAddress
}

$first = $true
$prevKey = ''
while ($true) {
    $ip = Get-TailnetIp
    $listening = Test-Listening $Port
    $sup = Get-GatewaySupervisor
    $supPid = if ($sup) { [int]$sup.ProcessId } else { 0 }
    $health = if ($listening -and $ip) { Test-GatewayHealth $ip } else { -1 }
    $action = 'none'

    # The first cycle is observation only: it must not create the very state it
    # is supposed to report on.
    if ($first) {
        Write-Log ("FIRST CHECK (nothing touched yet): tailnet={0} listening8443={1} supervisor={2} health={3}" -f `
            ($(if ($ip) { $ip } else { '(none)' })), $listening, ($(if ($supPid) { $supPid } else { '(none)' })), $health)
        $first = $false
    } elseif (-not $listening -and $ip -and -not $supPid -and -not $NoAutoStart) {
        Write-Log ("gateway missing: tailnet={0} but 8443 not listening and no supervisor -> starting {1}" -f $ip, $SupervisorScript)
        if (Test-Path $SupervisorScript) {
            Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $SupervisorScript
            ) -WindowStyle Hidden
            $action = 'started-supervisor'
            Start-Sleep -Seconds $StartupGraceSeconds
            $listening = Test-Listening $Port
            $sup = Get-GatewaySupervisor
            $supPid = if ($sup) { [int]$sup.ProcessId } else { 0 }
            $health = if ($listening -and $ip) { Test-GatewayHealth $ip } else { -1 }
            Write-Log ("after auto-start: listening8443={0} supervisor={1} health={2}" -f `
                $listening, ($(if ($supPid) { $supPid } else { '(none)' })), $health)
        } else {
            $action = 'supervisor-script-missing'
            Write-Log ("supervisor script not found: {0}" -f $SupervisorScript)
        }
    }

    # Transition logging: only state changes get a line, so the log stays readable.
    $key = "{0}|{1}|{2}" -f ($(if ($ip) { 1 } else { 0 })), $listening, ($(if ($supPid) { 1 } else { 0 }))
    if ($key -ne $prevKey) {
        if ($prevKey -ne '') {
            Write-Log ("state change: tailnet={0} listening8443={1} supervisor={2} listeningPid={3} health={4}" -f `
                ($(if ($ip) { $ip } else { '(none)' })), $listening, ($(if ($supPid) { $supPid } else { '(none)' })), (Get-ListeningPid $Port), $health)
        }
        $prevKey = $key
    }

    # ------------------------------------------------ token card delivery
    $token = ''
    try { $token = [string](Get-Content $script:StateJson -Raw | ConvertFrom-Json).token } catch { }
    $stateFresh = Test-StateFresh
    $cardDelivered = $false
    if ($token -and -not $stateFresh) {
        # Stale state file: the token belongs to a previous startup. Do NOT run the delivery
        # check (an old ok:true audit line would match) and do NOT let the fallback push send
        # a dead token to the phone. Just say it once per token.
        if ($script:StaleStateLogged -ne $token) {
            $script:StaleStateLogged = $token
            $stalePid = 0
            try { $stalePid = [int](Get-Content $script:StateJson -Raw | ConvertFrom-Json).pid } catch { }
            Write-Log ("web-state.json is STALE (written by pid {0}, which is not the live dsh on 3080): its token is from a PREVIOUS startup. No card is pushed (it would carry a dead token) and the delivery audit is not trusted. Waiting for the token-broadcast plugin (any start method) or the launcher to write this startup's token." -f $stalePid)
        }
    } elseif ($token) {
        $cardDelivered = Test-CardDelivered $token
        if ($cardDelivered) {
            $script:CardMissingSince = $null
        } elseif ($null -eq $script:CardMissingSince) {
            $script:CardMissingSince = Get-Date
            Write-Log ("token card for ...{0} not delivered yet (plugin push may be failing) - will retry" -f $token.Substring([Math]::Max(0, $token.Length - 8)))
        } elseif (((Get-Date) - $script:CardMissingSince).TotalSeconds -ge $CardGraceSeconds) {
            $verdict = Send-TokenCard
            if ($verdict -eq 'pushed') {
                Write-Log ("token card PUSHED by watcher (plugin push failed; fresh-process delivery worked) for ...{0}" -f $token.Substring([Math]::Max(0, $token.Length - 8)))
                $script:CardMissingSince = $null
                $cardDelivered = $true
                $action = 'pushed-card'
            } else {
                Write-Log ("watcher card push not successful: {0}" -f $verdict)
                $script:CardMissingSince = Get-Date
            }
        }
    }

    # ------------------------------------------------ launcher bypass check
    $bypass = Test-LauncherBypass
    if ($bypass -and $script:BypassLogged -ne $bypass) {
        Write-Log ("WARNING: dsh was NOT started through the launcher ({0}). Its session token is therefore unknown to every helper: no card will be pushed and the gateways cannot be registered. Restart with desktop dsh-hiboard.cmd (or dsh-start.ps1)." -f $bypass)
        $script:BypassLogged = $bypass
    } elseif (-not $bypass) {
        $script:BypassLogged = ''
    }

    # ------------------------------------------------ LAN entry self-check
    # With a stale state file the self-check would test a DEAD token and report a scary 401
    # that says nothing about the entry chain itself. Say what is actually true instead.
    $lanVerdict = 'stale-state(this startup token is unknown)'
    if ($stateFresh) { $lanVerdict = Test-LanEntry }
    if ($lanVerdict -ne $script:LanLogged) {
        if ($lanVerdict -like 'ok *') {
            Write-Log ("LAN entry self-check OK: {0}" -f $lanVerdict)
        } else {
            Write-Log ("WARNING: LAN entry self-check failed: {0} (the token in the URL must be the CURRENT startup's token; use the newest card)" -f $lanVerdict)
        }
        $script:LanLogged = $lanVerdict
    }

    # ------------------------------------------------ trustedHosts drift (report only)
    $drift = Test-TrustedHostDrift
    if ($drift -and $script:DriftLogged -ne $drift) {
        Write-Log ("WARNING: LAN address {0} is NOT listed in cordis.patch.yml trustedHosts - the LAN entry will show 'authentication required' even with the right token. Fix while dsh is STOPPED, then start it again." -f $drift)
        $script:DriftLogged = $drift
    } elseif (-not $drift) {
        $script:DriftLogged = ''
    }

    Write-State ([ordered]@{
        at            = (Get-Date).ToString('s')
        pid           = $PID
        tailnetIp     = $ip
        listening     = $listening
        listeningPid  = (Get-ListeningPid $Port)
        supervisorPid = $supPid
        health        = $health
        action        = $action
        cardDelivered = $cardDelivered
        stateFresh    = $stateFresh
        trustedHostDrift = $drift
        lanEntry      = $lanVerdict
        launcherBypass = $bypass
    })

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

Write-Log "watcher exiting"
