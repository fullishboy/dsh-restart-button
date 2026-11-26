# Starts the restart helper outside the app's process tree.
#
# A process started by Win32_Process.Create has WmiPrvSE.exe as its parent, so
# `taskkill /T` on the app never reaches it. The created process inherits the
# calling token, which matters here: the desktop app runs elevated, so a helper
# started any other way would be too weak to end it.
#
# ShowWindow has to be typed uint16 or the provider rejects the request with a
# type mismatch, and the helper would appear as a console window.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Helper,
  [Parameter(Mandatory = $true)][string]$Payload,
  [Parameter(Mandatory = $true)][string]$Log
)

$ErrorActionPreference = 'Stop'

function Write-Note([string]$Message) {
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -LiteralPath $Log -Value "$stamp launcher: $Message" -Encoding UTF8
  } catch {
    # Logging must never stop the hand-over.
  }
}

try {
  foreach ($required in @($Node, $Helper)) {
    if (-not (Test-Path -LiteralPath $required)) {
      Write-Note "missing file: $required"
      Write-Output 'PID=0'
      exit 1
    }
  }

  # Base64 keeps quotes and spaces out of the command line the provider parses.
  $commandLine = '"' + $Node + '" "' + $Helper + '" "' + $Payload + '"'
  Write-Note "creating the helper: $commandLine"

  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine              = $commandLine
    ProcessStartupInformation = $startup
  }

  Write-Note "Win32_Process.Create returned $($result.ReturnValue), pid $($result.ProcessId)"

  if ($result.ReturnValue -ne 0) {
    Write-Output 'PID=0'
    exit 1
  }

  Write-Output "PID=$($result.ProcessId)"
  exit 0
} catch {
  Write-Note "launcher failed: $($_.Exception.Message)"
  Write-Output 'PID=0'
  exit 1
}
