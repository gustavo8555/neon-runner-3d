<#
    Publica o NEON RUNNER 3D no GitHub Pages.

    ANTES DE RODAR: crie um repositorio VAZIO no GitHub
    (sem README, sem .gitignore) em https://github.com/new
    com o mesmo nome usado aqui (padrao: neon-runner-3d).

    Uso:
        .\publicar.ps1
        .\publicar.ps1 -Usuario meuuser -Repo meu-repo
#>
param(
    [string]$Usuario = "gustavo8555",
    [string]$Repo    = "neon-runner-3d",
    [string]$Mensagem = ""
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$env:GIT_TERMINAL_PROMPT = "0"

$url = "https://github.com/$Usuario/$Repo.git"
Write-Host ""
Write-Host "Repositorio local :" (Get-Location).Path
Write-Host "Destino           : $url"
Write-Host ""

# 1) commit de alteracoes pendentes
$pendente = git status --porcelain
if ($pendente) {
    Write-Host "> Commitando alteracoes pendentes..." -ForegroundColor Cyan
    git add -A
    $msg = if ($Mensagem) { $Mensagem } else { "Atualiza NEON RUNNER 3D" }
    git commit -m $msg
} else {
    Write-Host "> Nada novo para commitar." -ForegroundColor DarkGray
}

# 2) remote
$temRemote = (git remote) -contains "origin"
if ($temRemote) {
    $atual = git remote get-url origin
    if ($atual -ne $url) {
        Write-Host "> Atualizando remote origin ($atual -> $url)" -ForegroundColor Cyan
        git remote set-url origin $url
    }
} else {
    Write-Host "> Adicionando remote origin..." -ForegroundColor Cyan
    git remote add origin $url
}

# 3) push
Write-Host "> Enviando para o GitHub..." -ForegroundColor Cyan
git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Falha no push. Causas comuns:" -ForegroundColor Yellow
    Write-Host "  - o repositorio ainda nao existe (crie em https://github.com/new)"
    Write-Host "  - o nome do usuario/repositorio esta errado"
    Write-Host "  - falta autenticar (rode: gh auth login  ou use o Git Credential Manager)"
    exit 1
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " Enviado! Agora ative o Pages (uma vez so):" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Abra https://github.com/$Usuario/$Repo/settings/pages"
Write-Host "  2. Em 'Build and deployment' -> Source: Deploy from a branch"
Write-Host "  3. Branch: main   /   Folder: / (root)   ->  Save"
Write-Host ""
Write-Host "  Em ~1 minuto o jogo estara em:" -ForegroundColor Cyan
Write-Host "  https://$Usuario.github.io/$Repo/" -ForegroundColor Cyan
Write-Host ""
