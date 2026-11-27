# Scripts Guide

[中文](README.md) · **English** · [Auto-Generated Full File Index (Chinese)](INDEX.md)

This repository maintains three default LLM/API content workflows: daily digests, official conferences, and historical blog updates. Authoritative npm entry points live in root `package.json`, workflow-to-code mappings live in [docs/three-workflows.md](../docs/three-workflows.md) (Chinese), and the complete per-file catalog is auto-generated in [scripts/INDEX.md](INDEX.md) via `node scripts/generate-scripts-index.js`.

## Architecture Layers

| Layer | Entry Points & Adapters | Shared Core |
|---|---|---|
| Daily digest | `full-fetch.js`, `deep-analysis-only.js`, `batch-analyze.js`, `refresh-api-reader.js`, `reanalyze.js`, `reanalyze-selected.js` | `analysis-engine.js`, `deep-analyzer.js`, `analysis-contract.js`, `lib/daily-filter-prefilter.js`, `lib/filter-scope-evidence.js`, `lib/deep-arxiv-source-fetch.js`, `lib/deep-primary-sections.js`, `lib/analysis-contract-paper-exemptions.js`, `lib/reader-ordinal-format.js` |
| Official conferences | `official-conference-acquire.js`, `conference-discover.js`, `conference-filter-run.js`, `conference-process.js`, `migrate-conference-process.js` | Same engine, Reader, 8-dim rubric (`scoring-rubric.js`), 9-facet taxonomy |
| Historical updates | `historical-outdated-audit.js`, `historical-direct-rewrite-inputs.js`, `historical-direct-rewrite-plan.js`, `historical-direct-rewrite-run.js`, `history-resume.js` | Same engine with isolated historical scope and provenance adapters |
| Page rendering | `generate-blog.py`, `conference-page-render.py`, `historical-page-render.py`, `lib/historical-direct-aggregate.js` | `publish-to-blog.py`, `paper_reader_presentation.py`, `tag_presentation.py` |
| Review & push | `review-blog.py`, `push-blog.py`, `publish-conference.py`, `lib/historical-direct-publication.js`, `verify-web.js` | `publish_common.py`, `publish_llm_client.py`, `publish_manual_legacy.py`, `blog_core_summary_verifier.py`, `blog_reader_binding_verifier.py`, `tutorial_payload_verifier_core.py`, `markdown_hugo_gate.py`, `pinned_http_transport.py` |
| Infrastructure | `env-loader.js`, `project_env.py`, `workspace-role.js`, `runtime_guard.py`, `utils.js`, `llm-account-pool.js`, `llm_account_pool.py` | `config/runtime-paths.json` (shared JS/Python SSOT for `config.js` & `path_config.py`), `config/workspace-roles.json`, `lib/env-schema.js`, `lib/file-lock.js`, `lib/papers-backup.js`, `lib/physical-request-hook.js`, `lib/arxiv-origin-gate.js`, `publish_node_replay_client.py` |

The repository's JavaScript module graph enforces zero circular-dependency SCCs, guarded by `tests/architecture-scc-and-cycles.test.js`.

## Operational & Optional CLIs

| Command | Script | Purpose |
|---|---|---|
| `npm run doctor -- --offline` | `doctor.js` | Read-only preflight check (runtimes, proxy, pool, disk, blog repo); add `--network` to probe arXiv |
| `npm run config:check` | `config-check.js` | Validate `.env` required keys, ranges, reasoning tiers, and spelling against `lib/env-schema.js` |
| `npm run source:probe -- --date YYYY-MM-DD` | `source-probe.js` | Read-only probe of arXiv Atom, official OAI, and RSS announcement freshness |
| `npm run llm:accounts` / `llm:accounts:quota` | `llm-accounts-report.js` / `llm-accounts-quota.js` | Inspect shared pool schedule/cooldowns; sync or manage OpenCode Go `/zen/go/v1/usage` quotas and monthly reset dates |
| `npm run digest:status` / `digest:scorecard` | `digest-run-report.js` / `digest-scorecard.js` | Cold-verify full batch status and inspect per-stage latency, cache hits, and reasoning share (`--workflow daily\|conference\|history`) |
| `npm run history:outdated` | `historical-outdated-audit.js` | Read-only audit of outdated historical blog pages under `content/posts/` with ready-to-run rewrite commands |
| `npm run locks` | `locks.js` | Bounded read-only view of local and shared-blog locks plus stale-lock preview |
| `npm run recover` / `manifest:new` | `recover.js` / `manifest-new.js` | Summarize failure causes & next actions; prepare source-bound manual correction manifests |
| `npm run fact-feedback:new` / `reader-retry:new` | `fact-feedback-new.js` / `reader-retry-new.js` | Verify sealed four-file sources and generate source-bound fact-feedback bundles or explicit Reader retry manifests |
| `npm run verify:web` / `publish:finish` | `verify-web.js` / `publish-finish.js` | Verify Pages deploy, HTTP 200, and page titles; print post-push wrap-up checklist |
| `npm run digest:waive-visuals` | `waive-post-publish-visuals.js` | Record the standing no-visuals waiver bound to the current publication receipt and commit |
| `npm run reanalyze:selected -- <arxivId...>` | `reanalyze-selected.js` | Reanalyze only selected papers from the current sealed batch (supports source-bound fact feedback & `--natural-resource-prose`, no re-fetch) |
| `npm run table:check` / `review:overrides` | `table-check.js` / `review-overrides-cli.js` | Offline table precheck; validate strict-schema review false-positive override notes |
| `npm run papers:compact` | `compact-papers-ledger.js` | Atomically compact `data/current/papers.json` while preserving complete records |
| `npm run storage:pdf-dedupe` / `storage:report` / `storage:prune` | `runtime-storage.js` / `storage-report.js` | Byte-verify & CoW-dedupe duplicate PDFs, print retention advice, and preview reference-aware pruning |
| `npm run digest:calibrate` | `calibrate-batch-scores.js` | Opt-in CLI: post-batch Swiss Bradley-Terry relative score calibration (companion output) |
| `npm run podcast:generate` | `publish-daily-podcast.js` | Opt-in CLI: synthesize daily audio briefing via IndexTTS2 and optionally publish to GitHub Release; pass `--portal-repo` to sync `static/feeds/podcast.xml`, `data/podcast-episodes.json`, and `static/client/podcast/feed.json` |
| `npm run impact -- --git` | `impact.js` | Static reverse-dependency analysis listing impacted commands and exact JS/Python test suites |
| `npm run docs:check` | `docs-consistency.js` | Verify commands, versions, links/anchors, bilingual indexes, env vars, `env.example` sync, and `AGENTS.md` size |
| `node scripts/test-api-key.js` | `test-api-key.js` | Explicit routing diagnostic (sends minimal real requests to check primary/secondary models & proxy) |

### Opt-in / Standalone Evolution Modules

- `conference_layout_extractor.py`: layout-aware conference PDF extractor (now default `enhanced` mode for new conference runs with two-column reflow, structured tables, and 288 DPI crops; `conference_extractor.py` remains byte-frozen for historical receipts).
- `lib/arxiv-tex-source.js`, `arxiv_tex_extract.py`: on-demand arXiv `/src/<id>` LaTeX source AST sidecar fetcher and safe parser.
- `generate-scripts-index.js`: regenerate or `--check` [scripts/INDEX.md](INDEX.md).

## Legacy Compatibility Boundary

`manual/scripts` holds only legacy read-only contract verification and single-page independent manual review (`gpt-6.1-sol/high`). Regular daily, conference, and historical API pipelines are isolated from `manual/` and no longer eagerly load `manual/scripts/*` (`analysis-contract.js` lazy-loads retired manual contracts, while everyday publishing and the Hugo gate directly import `scripts/tutorial_payload_verifier_core.py` and `scripts/publish_manual_legacy.py`). Batch Manual authoring and WeChat/Feishu/Xiaohongshu publishers are retired. Historical prompts are verified read-only from original Git blobs via `lib/git-prompt-evidence-index.json`.

## Specialized Maintenance Commands

Conference ledger verification (`conference:validate-ledger`, `conference:verify-ledger`, `conference:validate-run`), taxonomy migration (`tags:validate`, `tags:preview`, `tags:serve`, `tags:update-records`, `tags:check-inventory`), historical identity arbitration (`history:arxiv-source`, `history:openreview-pdf-source`, `history:resolve-conflict`), keyword recall regression (`keyword:recall`), and operator waivers (`digest:waive-analysis`) are documented in their respective workflow guides and root `package.json`.

## Verification

```bash
npm run verify
npm run validate:data
npm run docs:check
node scripts/generate-scripts-index.js --check
```
