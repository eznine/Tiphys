# TIPHYS reference repos -> F:\tiphys\reference\<group>\<name>  (shallow clones, skips existing)
$ErrorActionPreference = "Continue"
$Root = "F:\tiphys\reference"
$Repos = @(
  @{ Group='agents'; Name='ai'; Url='https://github.com/vercel/ai' },
  @{ Group='agents'; Name='claude-agent-sdk-typescript'; Url='https://github.com/anthropics/claude-agent-sdk-typescript' },
  @{ Group='agents'; Name='claude-code'; Url='https://github.com/anthropics/claude-code' },
  @{ Group='agents'; Name='cline'; Url='https://github.com/cline/cline' },
  @{ Group='agents'; Name='codex'; Url='https://github.com/openai/codex' },
  @{ Group='agents'; Name='deepseek-harness'; Url='https://github.com/deepseek-ai/deepseek-harness' },
  @{ Group='agents'; Name='goose'; Url='https://github.com/block/goose' },
  @{ Group='agents'; Name='langgraphjs'; Url='https://github.com/langchain-ai/langgraphjs' },
  @{ Group='agents'; Name='mastra'; Url='https://github.com/mastra-ai/mastra' },
  @{ Group='agents'; Name='mem0'; Url='https://github.com/mem0ai/mem0' },
  @{ Group='agents'; Name='openai-agents-js'; Url='https://github.com/openai/openai-agents-js' },
  @{ Group='agents'; Name='pydantic-ai'; Url='https://github.com/pydantic/pydantic-ai' },
  @{ Group='agents'; Name='typescript-sdk'; Url='https://github.com/modelcontextprotocol/typescript-sdk' },
  @{ Group='gis'; Name='RustGIS'; Url='https://github.com/opengeos/RustGIS.git' },
  @{ Group='gis'; Name='GeoLibre'; Url='https://github.com/opengeos/GeoLibre.git' }
)
foreach ($r in $Repos) {
  $dest = Join-Path (Join-Path $Root $r.Group) $r.Name
  if (Test-Path $dest) { Write-Host "skip  $($r.Group)/$($r.Name) (exists)"; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Write-Host "clone $($r.Url) -> $dest"
  git clone --depth 1 $r.Url $dest
  if ($LASTEXITCODE -ne 0) { Write-Warning "FAILED: $($r.Url)" }
}
Write-Host "Done. $($Repos.Count) repos."
