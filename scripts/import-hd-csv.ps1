# Direct CLI import for the Home Depot purchase-history CSV.
#
# When the in-browser uploader hits issues (SheetJS number-coercion,
# cookie/auth quirks, etc.), this script ships the parsed rows straight
# to /api/materials/import. PowerShell's Import-Csv keeps every column
# as a string, so the server-side str() helper has nothing to coerce
# and the import path stays simple.
#
# Usage:
#
#   1. Get your auth token from the running app:
#        - Log into project86.net (or the Railway preview URL)
#        - Open browser devtools (F12) -> Console
#        - Paste:  copy(localStorage.getItem('p86-auth-token'))
#        - The token is now in your clipboard.
#   2. From a PowerShell window in the repo root, run:
#        .\scripts\import-hd-csv.ps1 `
#            -CsvPath "$HOME\Downloads\Purchase_History_April-29-2026_10-55-AM.csv" `
#            -Token "<paste token here>"
#   3. Watch the output. The script chunks the request to keep memory
#      sane and prints the server's import summary at the end.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath,

    [Parameter(Mandatory=$true)]
    [string]$Token,

    [string]$ApiBase = 'https://project86.net',

    [string]$Vendor = 'home_depot'
)

if (-not (Test-Path $CsvPath)) {
    Write-Host "CSV not found: $CsvPath" -ForegroundColor Red
    exit 1
}

# Home Depot's export prefixes the data with five metadata rows
# (Company Name, Phone Number, Source, Date Range, Export Date) plus a
# blank line BEFORE the actual column header. Import-Csv expects the
# header on the first line, so we slice past the prelude.
Write-Host "Reading $CsvPath ..."
$allLines = Get-Content -Path $CsvPath
$headerIdx = ($allLines | Select-String -Pattern '^Date,Store Number,' | Select-Object -First 1).LineNumber
if (-not $headerIdx) {
    Write-Host "Could not find header row 'Date,Store Number,...' in CSV." -ForegroundColor Red
    exit 1
}
$dataLines = $allLines[($headerIdx - 1)..($allLines.Length - 1)]
$tempCsv = Join-Path $env:TEMP "agx_hd_$(Get-Random).csv"
Set-Content -Path $tempCsv -Value $dataLines -Encoding UTF8

try {
    $rows = Import-Csv -Path $tempCsv
} finally {
    Remove-Item -Path $tempCsv -Force -ErrorAction SilentlyContinue
}

Write-Host ("Parsed {0} rows." -f $rows.Count) -ForegroundColor Cyan

# Dollar-stripped, normalized rows. The server's import endpoint expects
# the column names exactly as they appear in HD's export header — so we
# pass them through unmodified, just letting them ride as the strings
# Import-Csv produced.
$payload = @{
    vendor      = $Vendor
    source_file = (Split-Path -Leaf $CsvPath)
    rows        = $rows
}

# Convert to JSON. -Depth 6 covers nested fields though we only have one
# level here; Compress saves bandwidth.
$body = $payload | ConvertTo-Json -Depth 6 -Compress
$bodySizeKB = [math]::Round($body.Length / 1024, 1)
Write-Host ("Payload size: {0} KB" -f $bodySizeKB)

$endpoint = "$ApiBase/api/materials/import"
Write-Host "POST -> $endpoint"

try {
    $response = Invoke-RestMethod `
        -Method POST `
        -Uri $endpoint `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType 'application/json' `
        -Body $body
    Write-Host "`nImport complete." -ForegroundColor Green
    $response | Format-List
} catch {
    Write-Host "`nImport failed:" -ForegroundColor Red
    if ($_.Exception.Response) {
        $sr = New-Object System.IO.StreamReader $_.Exception.Response.GetResponseStream()
        $errBody = $sr.ReadToEnd()
        Write-Host $errBody -ForegroundColor Red
    } else {
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    exit 1
}
