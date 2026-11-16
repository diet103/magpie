<#
.SYNOPSIS
  Sets up Magpie (the Tell Me Anything Tracker) on Fly.io with one command.

.DESCRIPTION
  Run it with no arguments, or double-click setup.cmd. It:
    1. installs the Fly.io command-line tool if it is missing,
    2. opens the browser so you can log in to Fly.io,
    3. asks who may sign in (one or two email addresses),
    4. creates the app, its disk and its settings, and deploys it,
    5. checks that it answers, then prints the address to paste into Claude and a password for each person.

  It is safe to run again. It continues where it stopped, and on a finished setup it deploys the latest code.
  setup.sh does the same on macOS and Linux. Keep the two behaving alike.

  Later, when you want them:
    .\setup.cmd -Backups        continuous off-site backups to Cloudflare R2
    .\setup.cmd -Google         "Sign in with Google" instead of (or next to) passwords
    .\setup.cmd -Assistant      switch on the Ask box in the web app (uses your Anthropic API key)
    .\setup.cmd -NewPasswords   replace the sign-in passwords
    .\setup.cmd -DryRun         show what would happen, change nothing

  Every question has an option, so it can run without asking anything:
    -Email -Name -PartnerEmail -PartnerName   who may sign in (with -Email, a second person is added only by -PartnerEmail)
    -TimeZone America/Chicago                 the household's time zone (first setup; on a later run it changes it)
    -App my-name  -Region iad  -Org personal  the app's name and where it runs (first setup)
    -Yes                                      install the Fly.io tool without asking
    -GoogleOnly                               with -Google: switch password sign-in off without asking
    -NoShow                                   never print a password or key; they go to their files only. Use this when
                                              an AI assistant runs the script. It then refuses to ask for a secret.
  The add-ons take their values from the environment when these are set, instead of asking:
    -Assistant   MAGPIE_ANTHROPIC_API_KEY
    -Google      MAGPIE_GOOGLE_CLIENT_ID, MAGPIE_GOOGLE_CLIENT_SECRET
    -Backups     MAGPIE_R2_ACCOUNT_ID, MAGPIE_R2_BUCKET, MAGPIE_R2_ACCESS_KEY_ID, MAGPIE_R2_SECRET_ACCESS_KEY
#>
[CmdletBinding()]
param(
  [string]$Email,
  [string]$Name,
  [string]$PartnerEmail,
  [string]$PartnerName,
  [string]$App,
  [string]$Region = 'iad',
  [string]$Org = 'personal',
  [string]$TimeZone,
  [switch]$Google,
  [switch]$GoogleOnly,
  [switch]$Backups,
  [switch]$NewPasswords,
  [switch]$Assistant,
  [switch]$NoShow,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppLabel = 'Magpie'
$AppPrefix = 'magpie-'
$VolumeName = 'tracker_data'
$LoginFile = 'magpie-login.txt'
$PhotoKeyFile = 'magpie-photo-key.txt'
$script:Fly = $null
$script:MadePhotoKey = $false

# What Windows calls the common time zones, and the names the app needs. Anything else is typed in.
$WindowsZones = @{
  'Hawaiian Standard Time' = 'Pacific/Honolulu'; 'Alaskan Standard Time' = 'America/Anchorage'
  'Pacific Standard Time' = 'America/Los_Angeles'; 'US Mountain Standard Time' = 'America/Phoenix'
  'Mountain Standard Time' = 'America/Denver'; 'Central Standard Time' = 'America/Chicago'
  'Canada Central Standard Time' = 'America/Regina'; 'Eastern Standard Time' = 'America/New_York'
  'US Eastern Standard Time' = 'America/Indiana/Indianapolis'; 'Atlantic Standard Time' = 'America/Halifax'
  'Newfoundland Standard Time' = 'America/St_Johns'; 'Yukon Standard Time' = 'America/Whitehorse'
  'Pacific Standard Time (Mexico)' = 'America/Tijuana'; 'Mountain Standard Time (Mexico)' = 'America/Mazatlan'
  'Central Standard Time (Mexico)' = 'America/Mexico_City'
  'UTC' = 'UTC'; 'GMT Standard Time' = 'Europe/London'; 'Greenwich Standard Time' = 'Atlantic/Reykjavik'
  'W. Europe Standard Time' = 'Europe/Berlin'; 'Central Europe Standard Time' = 'Europe/Budapest'
  'Central European Standard Time' = 'Europe/Warsaw'; 'Romance Standard Time' = 'Europe/Paris'
  'FLE Standard Time' = 'Europe/Helsinki'; 'GTB Standard Time' = 'Europe/Bucharest'
  'E. Europe Standard Time' = 'Europe/Chisinau'; 'Turkey Standard Time' = 'Europe/Istanbul'
  'Russian Standard Time' = 'Europe/Moscow'
  'AUS Eastern Standard Time' = 'Australia/Sydney'; 'E. Australia Standard Time' = 'Australia/Brisbane'
  'Cen. Australia Standard Time' = 'Australia/Adelaide'; 'AUS Central Standard Time' = 'Australia/Darwin'
  'W. Australia Standard Time' = 'Australia/Perth'; 'Tasmania Standard Time' = 'Australia/Hobart'
  'New Zealand Standard Time' = 'Pacific/Auckland'
}

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---- output helpers ---------------------------------------------------------------------------------
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Info([string]$text) { Write-Host "   $text" }
function Good([string]$text) { Write-Host "   $text" -ForegroundColor Green }
function Note([string]$text) { Write-Host "   $text" -ForegroundColor Yellow }
function Stop-Setup([string]$text) { throw $text }

function Ask([string]$question, [string]$default = '') {
  if ($default) { $answer = Read-Host "$question [$default]" } else { $answer = Read-Host $question }
  if ($null -eq $answer) { $answer = '' }
  $answer = $answer.Trim()
  if (-not $answer) { return $default }
  return $answer
}

function Ask-YesNo([string]$question, [bool]$default) {
  if ($default) { $hint = 'Y/n' } else { $hint = 'y/N' }
  $answer = (Read-Host "$question [$hint]").Trim().ToLower()
  if (-not $answer) { return $default }
  return $answer.StartsWith('y')
}

# A value handed over in the environment (MAGPIE_...), so the script does not have to ask for it.
function Get-Given([string]$name) {
  $value = [Environment]::GetEnvironmentVariable("MAGPIE_$name")
  if ($null -eq $value) { return '' }
  return $value.Trim()
}

# With -NoShow nothing secret may pass through this window, so a step that has to ask for one is turned away.
function Assert-NoSecretPrompt([string]$what, [string]$option) {
  if ($NoShow) { Stop-Setup "$what would have to be typed here, and -NoShow means no secret is typed or shown in this window. Run this step yourself, in your own terminal: .\setup.cmd $option" }
}

# ---- flyctl -------------------------------------------------------------------------------------------
function Find-Fly {
  foreach ($name in @('flyctl', 'fly')) {
    $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
  }
  foreach ($path in @((Join-Path $HOME '.fly\bin\flyctl.exe'), (Join-Path $HOME '.fly\bin\fly.exe'))) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

function Install-Fly {
  Step 'Installing the Fly.io command-line tool'
  if ($DryRun) { Info '[dry run] would run the installer from https://fly.io/install.ps1'; return 'flyctl' }
  if (-not $Yes) {
    $answer = Read-Host '   The Fly.io tool is not on this computer. Install it now? [Y/n]'
    if ($null -eq $answer) { Stop-Setup 'Nobody answered. Run setup again with -Yes to install the Fly.io tool without being asked.' }
    $answer = $answer.Trim().ToLower()
    if ($answer -and -not $answer.StartsWith('y')) { Stop-Setup 'The Fly.io tool is needed. Install it from https://fly.io/docs/flyctl/install/ and run setup again.' }
  }
  Info 'Running the official installer from https://fly.io/install.ps1 (it goes into your user folder, under .fly).'
  $installer = (New-Object System.Net.WebClient).DownloadString('https://fly.io/install.ps1')
  Info 'Windows may ask for permission once: the installer adds a "fly" shortcut next to flyctl. Yes or No both work.'
  # Out-Host keeps the installer's messages out of this function's return value. Saying No to the shortcut makes
  # the installer report an error even though flyctl itself is in place, so check for the program afterwards.
  try { Invoke-Expression $installer | Out-Host } catch { Note "The installer reported: $($_.Exception.Message)" }
  $bin = Join-Path $HOME '.fly\bin'
  if ($env:Path -notlike "*$bin*") { $env:Path = "$bin;$env:Path" }
  $found = Find-Fly
  if (-not $found) { Stop-Setup 'The Fly.io tool did not install. Install it from https://fly.io/docs/flyctl/install/ and run setup again.' }
  return $found
}

# Hides the values of NAME=VALUE arguments when a command is shown on screen.
function Format-FlyArgs([string[]]$flyArgs) {
  $shown = foreach ($a in $flyArgs) { if ($a -match '^([A-Z][A-Z0-9_]+)=') { "$($Matches[1])=..." } else { $a } }
  return ($shown -join ' ')
}

# Runs flyctl with its output on screen. Stops the setup if it fails.
function Invoke-Fly([string[]]$flyArgs) {
  if ($DryRun) { Info "[dry run] fly $(Format-FlyArgs $flyArgs)"; return }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $script:Fly @flyArgs } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup "The command failed: fly $(Format-FlyArgs $flyArgs)`n   If Fly.io asked for a payment method, add a card at https://fly.io/dashboard/personal/billing and run setup again. It continues where it stopped."
  }
}

# Runs flyctl quietly and returns @{ Ok; Text }.
function Invoke-FlyQuiet([string[]]$flyArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $text = (& $script:Fly @flyArgs 2>&1 | Out-String) } finally { $ErrorActionPreference = $previous }
  return @{ Ok = ($LASTEXITCODE -eq 0); Text = $text }
}

# Runs a flyctl command that prints a JSON list and returns its items. Stops the setup if the command fails,
# because guessing "nothing there" could create a second disk or replace the sign-in passwords.
function Get-FlyList([string[]]$flyArgs) {
  if ($DryRun) { return @() }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $text = (& $script:Fly @flyArgs 2>$null | Out-String) } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { Stop-Setup "Could not read from Fly.io: fly $($flyArgs -join ' ')   Check your connection and run setup again." }
  $start = $text.IndexOf('[')
  $end = $text.LastIndexOf(']')
  if ($start -lt 0 -or $end -lt $start) { return @() }
  $parsed = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
  if ($null -eq $parsed) { return @() }
  return @($parsed | ForEach-Object { $_ })
}

function Test-AppIsMine([string]$name) {
  if ($DryRun -or -not $name) { return $false }
  return (Invoke-FlyQuiet @('status', '-a', $name)).Ok
}

function Get-SecretNames([string]$name) {
  return @(Get-FlyList @('secrets', 'list', '-a', $name, '--json') | ForEach-Object { $_.Name })
}

# ---- fly.toml -----------------------------------------------------------------------------------------
function Get-TomlValue([string]$key) {
  $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fly.toml'))
  $m = [regex]::Match($text, "(?m)^[ \t]*$key[ \t]*=[ \t]*[`"']([^`"']*)[`"']")
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

function Set-TomlValue([string]$key, [string]$value) {
  if ($DryRun) { Info "[dry run] would set $key = `"$value`" in fly.toml"; return }
  $path = Join-Path $PSScriptRoot 'fly.toml'
  $text = [IO.File]::ReadAllText($path)
  $updated = [regex]::Replace($text, "(?m)^([ \t]*)$key[ \t]*=[^\r\n]*", "`${1}$key = `"$value`"")
  if ($updated -ne $text) { [IO.File]::WriteAllText($path, $updated, (New-Object System.Text.UTF8Encoding $false)) }
}

# ---- small tools --------------------------------------------------------------------------------------
function New-RandomText([int]$length, [string]$alphabet) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $limit = 256 - (256 % $alphabet.Length)
  $buffer = New-Object byte[] 1
  $chars = New-Object System.Text.StringBuilder
  while ($chars.Length -lt $length) {
    $rng.GetBytes($buffer)
    if ($buffer[0] -lt $limit) { [void]$chars.Append($alphabet[$buffer[0] % $alphabet.Length]) }
  }
  return $chars.ToString()
}

# 20 random characters in five groups, without look-alikes such as 0/o or 1/l. About 99 bits.
function New-Password {
  $raw = New-RandomText 20 'abcdefghjkmnpqrstuvwxyz23456789'
  return (($raw -split '(.{4})' | Where-Object { $_ }) -join '-')
}

function Test-Email([string]$value) { return ($value -match '^[^@\s,=]+@[^@\s,=]+\.[^@\s,=]+$') }

function Get-CleanName([string]$value, [string]$email) {
  $clean = ($value -replace '[,="'']', '').Trim()
  if ($clean) { return $clean }
  $local = ($email -split '@')[0] -replace '[^A-Za-z]', ''
  if (-not $local) { return 'Me' }
  return $local.Substring(0, 1).ToUpper() + $local.Substring(1).ToLower()
}

function Test-TimeZone([string]$value) { return ($value -eq 'UTC' -or $value -match '^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){1,2}$') }

function Get-ComputerTimeZone {
  try { $windowsName = (& tzutil /g 2>$null | Out-String).Trim() } catch { return '' }
  if ($windowsName -and $WindowsZones.ContainsKey($windowsName)) { return $WindowsZones[$windowsName] }
  return ''
}

# The household's time zone decides what "today" is. Asked once, on the first setup.
function Get-HouseholdTimeZone {
  if ($TimeZone) { return $TimeZone }
  $suggestion = Get-ComputerTimeZone
  Info 'Which time zone is the household in? Use a name like America/Chicago or Europe/London'
  Info '(the full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).'
  foreach ($attempt in 1..3) {
    $answer = Ask '   Time zone' $suggestion
    if (Test-TimeZone $answer) { return $answer }
    Note "`"$answer`" is not a time zone name. It looks like America/Chicago: a region, a slash, a city."
  }
  Stop-Setup 'A time zone is needed. Run setup again with: .\setup.cmd -TimeZone America/Chicago'
}

function Save-LoginFile($people, [string]$url) {
  if ($DryRun) { Info "[dry run] would save the sign-in passwords in $LoginFile"; return }
  $lines = @("$AppLabel", '', "Web app:              $url", "Address for Claude:   $url/mcp", '', 'Sign-in:')
  foreach ($p in $people) { $lines += ("  {0,-10} {1,-32} {2}" -f $p.Name, $p.Email, $p.Password) }
  $lines += @('', 'Put the passwords in your password manager, then delete this file.', "New passwords any time: .\setup.cmd -NewPasswords")
  [IO.File]::WriteAllLines((Join-Path $PSScriptRoot $LoginFile), $lines)
  Good "Saved the sign-in passwords in $LoginFile, in this folder."
}

function Get-People {
  $people = @()
  $firstEmail = $Email
  if (-not $firstEmail) {
    $suggestion = ''
    try { $suggestion = (& git config user.email 2>$null | Out-String).Trim() } catch { }
    Info 'Who may sign in? Use the address each person will type to sign in.'
    $firstEmail = Ask '   Your email' $suggestion
  }
  if (-not (Test-Email $firstEmail)) { Stop-Setup "`"$firstEmail`" does not look like an email address." }
  $firstName = $Name
  if (-not $firstName -and -not $Email) { $firstName = Ask '   Your first name' (Get-CleanName '' $firstEmail) }
  $people += @{ Email = $firstEmail.ToLower(); Name = (Get-CleanName $firstName $firstEmail) }

  $secondEmail = $PartnerEmail
  if (-not $secondEmail -and -not $Email) { $secondEmail = Ask '   A second person''s email (press Enter to skip)' }
  if ($secondEmail) {
    if (-not (Test-Email $secondEmail)) { Stop-Setup "`"$secondEmail`" does not look like an email address." }
    if ($secondEmail.ToLower() -eq $firstEmail.ToLower()) { Stop-Setup 'The two email addresses are the same.' }
    $secondName = $PartnerName
    if (-not $secondName -and -not $PartnerEmail) { $secondName = Ask '   Their first name' (Get-CleanName '' $secondEmail) }
    $people += @{ Email = $secondEmail.ToLower(); Name = (Get-CleanName $secondName $secondEmail) }
  }
  foreach ($p in $people) { $p.Password = New-Password }
  return $people
}

function Get-Http([string]$method, [string]$url) {
  try { Add-Type -AssemblyName System.Net.Http } catch { }
  try {
    if (-not $script:Http) {
      $script:Http = New-Object System.Net.Http.HttpClient
      $script:Http.Timeout = [TimeSpan]::FromSeconds(15)
    }
    $request = New-Object System.Net.Http.HttpRequestMessage (New-Object System.Net.Http.HttpMethod $method), $url
    $response = $script:Http.SendAsync($request).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $challenge = ''
    if ($response.Headers.WwwAuthenticate) { $challenge = ($response.Headers.WwwAuthenticate | ForEach-Object { $_.ToString() }) -join ', ' }
    return @{ Status = [int]$response.StatusCode; Body = $body; Challenge = $challenge }
  } catch {
    return @{ Status = 0; Body = ''; Challenge = '' }
  }
}

function Wait-Healthy([string]$url, [int]$minutes = 5) {
  if ($DryRun) { Info "[dry run] would wait for $url/healthz"; return }
  Info "Waiting for $url to answer (a new address can take a minute or two)..."
  $deadline = (Get-Date).AddMinutes($minutes)
  while ((Get-Date) -lt $deadline) {
    if ((Get-Http 'GET' "$url/healthz").Status -eq 200) { Good 'It is up.'; return }
    Start-Sleep -Seconds 5
  }
  Stop-Setup "$url did not answer within $minutes minutes. Look at the logs with: fly logs -a $script:AppName   Then run setup again."
}

function Test-Deployment([string]$url) {
  if ($DryRun) { Info '[dry run] would run 3 checks: the sign-in page, the address for Claude, and the sign-in details Claude reads'; return }
  $failed = 0
  $login = Get-Http 'GET' "$url/login"
  if ($login.Status -eq 200) { Good 'ok      1. The sign-in page loads.' }
  else { $failed++; Note "FAILED  1. The sign-in page answered $($login.Status)." }
  $mcp = Get-Http 'POST' "$url/mcp"
  if ($mcp.Status -eq 401 -and $mcp.Challenge -like '*resource_metadata*') { Good 'ok      2. The address for Claude asks for sign-in.' }
  else { $failed++; Note "FAILED  2. The address for Claude answered $($mcp.Status) instead of asking for sign-in." }
  $meta = Get-Http 'GET' "$url/.well-known/oauth-protected-resource/mcp"
  if ($meta.Status -eq 200 -and $meta.Body -like "*$url/mcp*") { Good 'ok      3. The sign-in details Claude reads give the right address.' }
  else { $failed++; Note 'FAILED  3. The sign-in details Claude reads are missing or give the wrong address.' }
  if ($failed) { $script:ChecksFailed = $failed; Note "It is running, but $failed of the 3 checks failed. Logs: fly logs -a $script:AppName --no-tail" }
  else { Good 'All 3 checks passed.' }
}

function Show-ConnectSteps([string]$url) {
  Write-Host ''
  Write-Host '   Connect Claude (each person does this once, from their own Claude account):' -ForegroundColor Cyan
  Info '1. Open https://claude.ai > Customize > Connectors > Add custom connector.'
  Info "2. Name: $AppLabel     URL: $url/mcp"
  Info '3. Click Connect, sign in, and choose Allow. The phone app picks it up from your account.'
  Info "Then just talk to Claude: `"we went to that new pho place tonight, 4 out of 5.`""
  Info "Browse and fix things at $url (in Chrome on your phone: menu > Add to Home screen)."
}

# ---- start --------------------------------------------------------------------------------------------
try {
  Set-Location $PSScriptRoot
  if (-not (Test-Path 'fly.toml') -or -not (Test-Path 'Dockerfile')) { Stop-Setup 'Run this from the tracker folder (the one with fly.toml and Dockerfile).' }
  Write-Host ''
  Write-Host "$AppLabel setup" -ForegroundColor Cyan
  if ($DryRun) { Note 'Dry run: nothing will be installed, created or changed.' }
  if ($TimeZone -and -not (Test-TimeZone $TimeZone)) { Stop-Setup "`"$TimeZone`" is not a time zone name. Use one like America/Chicago or Europe/London." }
  if ($Assistant -and -not (Get-Given 'ANTHROPIC_API_KEY')) { Assert-NoSecretPrompt 'An Anthropic API key' '-Assistant' }
  if ($Google -and -not ((Get-Given 'GOOGLE_CLIENT_ID') -and (Get-Given 'GOOGLE_CLIENT_SECRET'))) { Assert-NoSecretPrompt 'The Google client secret' '-Google' }
  if ($Backups -and -not ((Get-Given 'R2_ACCOUNT_ID') -and (Get-Given 'R2_ACCESS_KEY_ID') -and (Get-Given 'R2_SECRET_ACCESS_KEY'))) { Assert-NoSecretPrompt 'The Cloudflare R2 keys' '-Backups' }

  $script:Fly = Find-Fly
  if (-not $script:Fly) { $script:Fly = Install-Fly } else { Info "Fly.io tool: $script:Fly" }

  if (-not $DryRun) {
    if (-not (Invoke-FlyQuiet @('auth', 'whoami')).Ok) {
      Step 'Log in to Fly.io'
      Info 'A browser window opens. Log in, or create an account (Fly.io needs a card on file; this costs about $4 a month).'
      Invoke-Fly @('auth', 'login')
    }
    # Say whose account this is: the app is created in it and billed to it.
    $who = Invoke-FlyQuiet @('auth', 'whoami')
    if ($who.Ok) { Info "Fly.io account: $(($who.Text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim())" }
  }

  # ---- which app? -------------------------------------------------------------------------------------
  $tomlApp = Get-TomlValue 'app'
  $existing = $false
  if ($App) { $script:AppName = $App.ToLower(); $existing = Test-AppIsMine $script:AppName }
  elseif (Test-AppIsMine $tomlApp) { $script:AppName = $tomlApp; $existing = $true }
  else { $script:AppName = '' }

  if ($existing -and -not $PSBoundParameters.ContainsKey('Region')) {
    $tomlRegion = Get-TomlValue 'primary_region'
    if ($tomlRegion) { $Region = $tomlRegion }
  }

  if (-not $existing -and ($Google -or $Backups -or $NewPasswords)) {
    Stop-Setup 'There is no deployed tracker yet. Run setup with no options first.'
  }

  # ---- add-ons for an existing deployment ---------------------------------------------------------------
  if ($existing -and $Google) {
    $url = "https://$script:AppName.fly.dev"
    Step 'Add "Sign in with Google"'
    Info '1. Open https://console.cloud.google.com/auth/clients (create a project if it asks; under Audience choose External and publish the app).'
    Info '2. Create client > Web application.'
    Info "3. Under Authorized redirect URIs add:  $url/auth/google/callback"
    try { Set-Clipboard -Value "$url/auth/google/callback"; Info '   (That address is on your clipboard.)' } catch { }
    Info '4. Copy the client ID and client secret it shows and paste them here.'
    Info 'People sign in with the same email addresses you gave this setup.'
    $id = Get-Given 'GOOGLE_CLIENT_ID'
    $secret = Get-Given 'GOOGLE_CLIENT_SECRET'
    $asked = -not ($id -and $secret)
    if ($asked) {
      $id = Ask '   Client ID' $id
      $secret = Ask '   Client secret'
    }
    if (-not $id -or -not $secret) { Stop-Setup 'Both values are needed. Nothing was changed.' }
    Invoke-Fly @('secrets', 'set', '-a', $script:AppName, "GOOGLE_CLIENT_ID=$id", "GOOGLE_CLIENT_SECRET=$secret")
    if ((Get-SecretNames $script:AppName) -contains 'LOGIN_PASSWORDS') {
      # Passwords stay unless -GoogleOnly says otherwise. The question is only put to someone who is typing.
      $keep = -not $GoogleOnly
      if ($keep -and $asked) { $keep = Ask-YesNo '   Keep password sign-in as well?' $true }
      if (-not $keep) { Invoke-Fly @('secrets', 'unset', '-a', $script:AppName, 'LOGIN_PASSWORDS') }
    }
    Wait-Healthy $url
    Good 'Google sign-in is on.'
    return
  }

  if ($existing -and $Backups) {
    $url = "https://$script:AppName.fly.dev"
    Step 'Add continuous backups (Cloudflare R2)'
    Info '1. In the Cloudflare dashboard open R2 and create a bucket (for example tracker-backups).'
    Info '2. R2 > Manage API tokens > Create token with Object Read & Write, limited to that bucket.'
    Info '3. Paste the values here. The account ID is on the R2 overview page.'
    $account = Get-Given 'R2_ACCOUNT_ID'
    $bucket = Get-Given 'R2_BUCKET'
    $key = Get-Given 'R2_ACCESS_KEY_ID'
    $secret = Get-Given 'R2_SECRET_ACCESS_KEY'
    if (-not $bucket) { $bucket = 'tracker-backups' }
    if (-not ($account -and $key -and $secret)) {
      $account = Ask '   Account ID' $account
      $bucket = Ask '   Bucket name' $bucket
      $key = Ask '   Access key ID' $key
      $secret = Ask '   Secret access key'
    }
    if (-not $account -or -not $key -or -not $secret) { Stop-Setup 'All four values are needed. Nothing was changed.' }
    Invoke-Fly @('secrets', 'set', '-a', $script:AppName, "R2_ACCOUNT_ID=$account", "R2_BUCKET=$bucket", "LITESTREAM_ACCESS_KEY_ID=$key", "LITESTREAM_SECRET_ACCESS_KEY=$secret")
    Wait-Healthy $url
    Good 'Backups are on: every change is copied to R2 within seconds, plus a nightly snapshot.'
    Info "Check with: fly logs -a $script:AppName   (look for lines from litestream)"
    return
  }

  # ---- first-time setup, or continuing one ----------------------------------------------------------------
  if (-not $existing) {
    $people = @(Get-People)
    $TimeZone = Get-HouseholdTimeZone
    Step 'Creating the app on Fly.io'
    if ($script:AppName) { $candidates = @($script:AppName) }
    else { $candidates = @(1..4 | ForEach-Object { $AppPrefix + (New-RandomText 4 'abcdefghijklmnopqrstuvwxyz0123456789') }) }
    $created = $false
    foreach ($candidate in $candidates) {
      if ($DryRun) { Info "[dry run] fly apps create $candidate -o $Org"; $script:AppName = $candidate; $created = $true; break }
      $result = Invoke-FlyQuiet @('apps', 'create', $candidate, '-o', $Org)
      if ($result.Ok) { $script:AppName = $candidate; $created = $true; Good "Created $candidate."; break }
      if ($result.Text -match '(?i)taken|already|not available|reserved') { Info "The name $candidate is taken; trying another."; continue }
      Write-Host $result.Text
      Stop-Setup 'Fly.io would not create the app (see the message above). If it asked for a payment method, add a card at https://fly.io/dashboard/personal/billing and run setup again.'
    }
    if (-not $created) { Stop-Setup 'Could not find a free app name. Run setup again with: .\setup.cmd -App some-name-you-like' }
  } else {
    Info "Found your tracker on Fly.io: $script:AppName"
    $people = $null
  }
  $url = "https://$script:AppName.fly.dev"
  Set-TomlValue 'app' $script:AppName
  if (-not $existing) { Set-TomlValue 'primary_region' $Region }
  # A tracker that is already running keeps the time zone in fly.toml unless -TimeZone names another.
  if ($TimeZone) { Set-TomlValue 'HOUSEHOLD_TZ' $TimeZone }

  $volumes = @(Get-FlyList @('volumes', 'list', '-a', $script:AppName, '--json') | Where-Object { $_.Name -eq $VolumeName })
  if ($volumes.Count -eq 0) {
    Step 'Creating the disk for the database (1 GB, daily snapshots kept 14 days)'
    Invoke-Fly @('volumes', 'create', $VolumeName, '-a', $script:AppName, '-r', $Region, '-s', '1', '--snapshot-retention', '14', '--yes')
  }

  $secretNames = Get-SecretNames $script:AppName

  # Photos and sensitive entries are encrypted with a key that lives in the app's settings, not on its disk.
  if (-not ($secretNames -contains 'FILES_KEY')) {
    Step 'Creating the key that encrypts photos and sensitive entries'
    $script:MadePhotoKey = $true
    $keyBytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
    $photoKey = [Convert]::ToBase64String($keyBytes)
    Invoke-Fly @('secrets', 'set', '--stage', '-a', $script:AppName, "FILES_KEY=$photoKey")
    if (-not $DryRun) {
      [IO.File]::WriteAllLines((Join-Path $PSScriptRoot $PhotoKeyFile), @("$AppLabel photo key (FILES_KEY)", '', $photoKey, '', 'Photos and sensitive entries are encrypted with this key. If the app is ever rebuilt from scratch, it needs this exact key to open them again.', 'Put it in your password manager, then delete this file.'))
      Note "Saved a copy in $PhotoKeyFile. Put it in your password manager, then delete that file."
    } else {
      Info "[dry run] would save a copy of the key in $PhotoKeyFile"
    }
  }

  if ($Assistant) {
    Step 'Switching on the Ask box'
    Info 'It runs on an Anthropic API key, billed to your API credits for everyone who can sign in.'
    Info 'Create one at https://console.anthropic.com/settings/keys (a separate key just for this is best, with a monthly spend limit).'
    $apiKey = Get-Given 'ANTHROPIC_API_KEY'
    if (-not $apiKey) { $apiKey = Ask '   API key (starts with sk-ant-)' }
    if ($apiKey -notmatch '^sk-ant-[A-Za-z0-9_\-]{20,}$') { Stop-Setup 'That does not look like an Anthropic API key. Nothing was changed.' }
    Invoke-Fly @('secrets', 'set', '--stage', '-a', $script:AppName, "ANTHROPIC_API_KEY=$apiKey")
  }

  $firstConfig = -not ($secretNames -contains 'ALLOWED_USERS')
  if ($firstConfig -or $NewPasswords) {
    if (-not $people) { $people = @(Get-People) }
    Step 'Saving settings'
    $allowed = ($people | ForEach-Object { "$($_.Email)=$($_.Name)" }) -join ','
    $passwords = ($people | ForEach-Object { "$($_.Email)=$($_.Password)" }) -join ','
    $settings = @("PUBLIC_URL=$url", "ALLOWED_USERS=$allowed", "LOGIN_PASSWORDS=$passwords")
    if ($firstConfig) { $settings += 'BOOTSTRAP_EMPTY_DB=1' }
    Invoke-Fly (@('secrets', 'set', '--stage', '-a', $script:AppName) + $settings)
    # Before the deploy, so a deploy that fails cannot lose the passwords that are now in effect.
    Save-LoginFile $people $url
  } else {
    $people = $null
  }

  Step 'Building and deploying (the first time takes a few minutes)'
  Invoke-Fly @('deploy', '-a', $script:AppName, '--ha=false')
  # A first deploy normally gives the app its public addresses; make sure, so the wait below cannot hang.
  if (-not $DryRun -and @(Get-FlyList @('ips', 'list', '-a', $script:AppName, '--json')).Count -eq 0) {
    Invoke-Fly @('ips', 'allocate-v4', '--shared', '-a', $script:AppName)
    Invoke-Fly @('ips', 'allocate-v6', '-a', $script:AppName)
  }
  Wait-Healthy $url

  # The "it is fine to start with an empty database" switch is only for the very first start.
  if ($DryRun -or ((Get-SecretNames $script:AppName) -contains 'BOOTSTRAP_EMPTY_DB')) {
    Step 'Locking the database against accidental resets'
    Invoke-Fly @('secrets', 'unset', '-a', $script:AppName, 'BOOTSTRAP_EMPTY_DB')
    Wait-Healthy $url
  }

  Step 'Checking it'
  Test-Deployment $url

  if ($DryRun) {
    Write-Host ''
    Note 'That was a dry run. Nothing was installed, created or changed, and it did not check your Fly.io sign-in or card.'
    Note "A real run picks its own address; $script:AppName was only an example."
    Write-Host ''
    exit 0
  }

  Write-Host ''
  Write-Host "$AppLabel is running at $url" -ForegroundColor Green
  if ($people) {
    Write-Host ''
    Write-Host '   Sign-in (email and password):' -ForegroundColor Cyan
    if ($NoShow) {
      foreach ($p in $people) { Info ("{0,-10} {1}" -f $p.Name, $p.Email) }
      Info "The passwords are not shown here. Open $LoginFile in this folder to read them."
    } else {
      foreach ($p in $people) { Info ("{0,-10} {1,-32} {2}" -f $p.Name, $p.Email, $p.Password) }
      if (-not $DryRun) { Info "Also saved in $LoginFile in this folder." }
    }
    Info "Put the passwords in your password manager, then delete $LoginFile."
  }
  try { if (-not $DryRun) { Set-Clipboard -Value "$url/mcp"; Info "The address for Claude ($url/mcp) is on your clipboard." } } catch { }
  Show-ConnectSteps $url
  if (-not ((Get-SecretNames $script:AppName) -contains 'ANTHROPIC_API_KEY')) {
    Write-Host ''
    Note 'Ask box: to save and search from inside the web app using your Anthropic API credits, run .\setup.cmd -Assistant'
  }
  if (-not ((Get-SecretNames $script:AppName) -contains 'R2_BUCKET')) {
    Write-Host ''
    Note 'Backups: Fly.io keeps a daily snapshot of the disk for 14 days. For continuous off-site backups, run .\setup.cmd -Backups when you have ten minutes.'
  }
  if ($script:MadePhotoKey -or (Test-Path (Join-Path $PSScriptRoot $PhotoKeyFile))) {
    Write-Host ''
    Note "Important: save $PhotoKeyFile in your password manager now, then delete the file."
    Note 'Photos and sensitive entries cannot be recovered without the key in it.'
  }
  Write-Host ''
  # A failed check is a failed setup, so anything running this script can tell.
  if ($script:ChecksFailed) { exit 1 }
} catch {
  Write-Host ''
  Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  exit 1
}
