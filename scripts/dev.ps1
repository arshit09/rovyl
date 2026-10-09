# Stop any running copy of THIS build, then run whatever was asked.
#
# It exists because a running executable holds its own file open, so a rebuild fails with
# "Access is denied". It only ever stops the binary under this tree, never the user's installed
# Rovyl — matching on the full path rather than on the process name is the whole point.
param([Parameter(ValueFromRemainingArguments = $true)] $Command)

$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Get-Process -Name rovyl -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$here\*" } |
    Stop-Process -Force
Start-Sleep -Milliseconds 300

if ($Command) {
    & $Command[0] @($Command[1..($Command.Length - 1)])
    exit $LASTEXITCODE
}
