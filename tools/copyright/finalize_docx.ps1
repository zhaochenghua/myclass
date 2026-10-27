param(
    [Parameter(Mandatory = $true)][string]$Docx,
    [Parameter(Mandatory = $true)][string]$Pdf
)

$ErrorActionPreference = 'Stop'
$docxPath = (Resolve-Path -LiteralPath $Docx).Path
$pdfPath = [System.IO.Path]::GetFullPath($Pdf)
$pdfDir = Split-Path -Parent $pdfPath
if (-not (Test-Path -LiteralPath $pdfDir)) {
    New-Item -ItemType Directory -Force -Path $pdfDir | Out-Null
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($docxPath, $false, $false)
    try {
        foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
        $doc.Fields.Update() | Out-Null
        $doc.Repaginate()
        $pages = $doc.ComputeStatistics(2)
        $doc.ExportAsFixedFormat($pdfPath, 17, $false, 0, 0, 0, 0, 0, $true)
        $doc.Fields.Update() | Out-Null
        $doc.Repaginate()
        foreach ($section in $doc.Sections) {
            foreach ($header in $section.Headers) { $header.Range.Fields.Update() | Out-Null }
            foreach ($footer in $section.Footers) { $footer.Range.Fields.Update() | Out-Null }
        }
        $doc.Save()
        Write-Output "PDF_OK pages=$pages docx=$docxPath pdf=$pdfPath"
    }
    finally {
        $doc.Close($false)
    }
}
finally {
    try { $word.Quit() } catch { Write-Output "WARN word.quit: $($_.Exception.Message)" }
}

