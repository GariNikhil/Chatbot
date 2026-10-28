$path = "D:\projects\MNC\Chatbot"
Get-ChildItem -Path $path -Recurse -File | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    if ($content -match "Chatbot") {
        $newContent = $content -replace "Chatbot", "Chatbot"
        Set-Content -Path $_.FullName -Value $newContent -NoNewline
        Write-Host "Updated: $($_.FullName)"
    }
}
