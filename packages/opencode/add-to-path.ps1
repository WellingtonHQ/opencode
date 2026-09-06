$ErrorActionPreference = "Stop"

$target = Join-Path $env:USERPROFILE ".opencode\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$systemPath = [Environment]::GetEnvironmentVariable("Path", "Machine")

if (($null -ne $userPath) -and ($userPath -split ";") -contains $target) {
    Write-Host "$target is already in your user PATH"
} elseif (($null -ne $systemPath) -and ($systemPath -split ";") -contains $target) {
    Write-Host "$target is already in your system PATH"
} else {
    if (-not $userPath) {
        [Environment]::SetEnvironmentVariable("Path", $target, "User")
        Write-Host "Added $target to user PATH (was empty)"
    } else {
        [Environment]::SetEnvironmentVariable("Path", "$target;$userPath", "User")
        Write-Host "Added $target to the front of your user PATH"
    }
}

Write-Host "Note: open a new terminal for the change to take effect."
