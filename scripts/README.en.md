# Scripts Guide

[中文](README.md) · **English** · [Auto-Generated Full File Index (Chinese)](INDEX.md)

This repository maintains three default LLM/API content workflows: daily digests, official conferences, and historical blog updates. Authoritative npm entry points live in root `package.json`, workflow-to-code mappings live in [docs/three-workflows.md](../docs/three-workflows.md) (Chinese), and the complete per-file catalog is auto-generated in [scripts/INDEX.md](INDEX.md) via `node scripts/generate-scripts-index.js`.

## Architecture Layers

| Layer | Entry Points & Adapters | Shared Core |
|---|---|---|
| Daily digest | `full-fetch.js`, `deep-analysis-only.js`, `batch-analyze.js`, `refresh-api-reader.js`, `reanalyze.js`, `reanalyze-selected.js` | `analysis-engine.js`, `deep-analyzer.js`, `analysis-contract.js` |
| Official conferences | `official-conference-acquire.js`, `conference-discover.js`, `conference-filter-run.js`, `conference-process.js`, `migrate-conference-process.js` | Same engine, Reader, 8-dim rubric (`scoring-rubric-v2.js`), 9-facet taxonomy |
| Historical updates | `historical-direct-rewrite-inputs.js`, `historical-direct-rewrite-plan.js`, `historical-direct-rewrite-run.js`, `history-resume.js` | Same engine with isolated historical scope and provenance adapters |
| Page rendering | `generate-blog.py`, `conference-page-render.py`, `historical-page-render.py`, `lib/historical-direct-aggregate.js` | `publish-to-blog.py`, `paper_reader_presentation.py`, `tag_presentation.py` |
| Review & push | `review-blog.py`, `push-blog.py`, `publish-conference.py`, `lib/historical-direct-publication.js`, `verify-web.js` | `publish_common.py`, `blog_reader_binding_verifier.py`, `markdown_hugo_gate.py` |
| Infrastructure | `env-loader.js`, `project_env.py`, `workspace-role.js`, `runtime_guard.py`, `utils.js`, `llm-account-pool.js` | `config/workspace-roles.json`, `lib/env-schema.js`, `lib/arxiv-origin-gate.js`, `publish_node_replay_client.py` |

## Operational & Optional CLIs

- **Health & config**: `npm run doctor -- --offline`, `npm run config:check`, `npm run llm:accounts`, `npm run source:probe -- --date YYYY-MM-DD`, `node scripts/test-api-key.js`.
- **Progress & telemetry**: `npm run digest:status -- --date YYYY-MM-DD`, `npm run digest:scorecard -- --date YYYY-MM-DD`, `npm run locks`.
- **Recovery & diagnostics**: `npm run recover -- --date YYYY-MM-DD`, `npm run manifest:new -- --spec SPEC.json`, `npm run table:check -- --draft FILE`, `npm run review:overrides -- --date DATE --file F.json`.
- **Storage hygiene**: `npm run papers:compact`, `npm run storage:pdf-dedupe`, `npm run storage:report`, `npm run storage:prune`.
- **Opt-in CLIs**: `npm run digest:calibrate` (post-batch Bradley-Terry relative score calibration), `npm run podcast:generate` (daily audio briefing synthesis via IndexTTS2 and optional GitHub Release publishing).
- **Opt-in extraction helpers**: `conference_extractor_v2.py` (layout-aware conference extractor; `conference_extractor.py` remains byte-frozen for legacy receipts) and `lib/arxiv-tex-source.js` / `arxiv_tex_extract.py` (arXiv TeX source AST extraction).

## Legacy Compatibility Boundary

`manual/scripts` holds only legacy read-only contract verification and single-page independent manual review (`gpt-6.1-sol/high`). Batch Manual authoring and WeChat/Feishu/Xiaohongshu publishers are retired. Historical prompts are verified read-only from original Git blobs via `lib/git-prompt-evidence-index.json`.

## Verification

```bash
npm run verify
npm run validate:data
npm run docs:check
node scripts/generate-scripts-index.js --check
```
