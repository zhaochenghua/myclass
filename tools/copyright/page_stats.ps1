param(
    [Parameter(Mandatory = $true)][string]$Docx
)

$ErrorActionPreference = 'Stop'
$docxPath = (Resolve-Path -LiteralPath $Docx).Path

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($docxPath, $false, $true)
    try {
        $pages = $doc.ComputeStatistics(2)
        for ($i = 1; $i -le $pages; $i++) {
            $start = $doc.GoTo(1, 1, $i).Start
            if ($i -lt $pages) {
                $end = $doc.GoTo(1, 1, ($i + 1)).Start - 1
            }
            else {
                $end = $doc.Content.End
            }
            $range = $doc.Range($start, $end)
            $lines = $range.ComputeStatistics(1)
            Write-Output ("page {0,3}: {1,3} lines" -f $i, $lines)
        }
    }
    finally {
        $doc.Close($false)
    }
}
finally {
    try { $word.Quit() } catch { }
}
