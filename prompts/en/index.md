# Prompt Documentation Index

This directory contains all LLM prompts for the audio-paper-digest skill, separated from code to enable independent iteration.

## Document List

| File | Purpose | Called From |
|------|---------|-------------|
| [filter.md](filter.md) | Filtering stage: determine whether a single paper is related to speech / music / audio | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | Deep analysis stage (round 1, text-only): read full text and output structured report | `deep-analyzer.js` |
| [opensource-scan.md](opensource-scan.md) | Open-source scan stage (round 2): specifically extract open-source links and reproduction information | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | Deep analysis stage (round 3): review and rewrite the earlier rounds' results against the original text | `deep-analyzer.js` |

> Note: `image-supplement.md`, `method-fill.md`, `table-fill.md`, `structure-repair.md`, `scoring-audit.md`, and the non-LLM Manual v4 authoring contract `manual-analysis-record.md` have **no English versions**. See the Chinese [prompts/index.md](../index.md).

The English directory is therefore a partial documentation/compatibility mirror, not a complete independently executable pipeline. Likewise, a manual artifact that satisfies the same output and provenance contracts must not be described as having executed the corresponding LLM stages.

## Placeholder Conventions

Template placeholders in each prompt are denoted by `{variableName}`; the code injects actual values via string replacement after reading the file. See the "Invocation" section in each document for specific placeholders.

## Loading Rules

- `loadPrompt()` reads only the first fenced code block in the markdown file as the runtime prompt.
- If the prompt body itself needs to show code fences, the outer fenced block must use a longer fence such as ```` or `~~~~`, otherwise the first inner ``` block will truncate the loaded prompt.
- When adding a `{variableName}` placeholder, update the calling code and tests at the same time. Unreplaced placeholders currently produce warnings rather than automatically stopping the pipeline.

## Modification Suggestions

- When adjusting the tag system, scoring criteria, or output format, synchronize `scripts/utils.js`, `scripts/utils.py`, analysis/publish validators, fixtures, and both language variants.
- Type-aware scoring uses the controlled `document_type` field (方法研究 / 系统技术报告 / 模型报告 / 数据集与基准 / 综述 / 理论研究 / 应用研究). Keep `deep-analysis.md`, `gap-fill.md`, and both English variants synchronized.
- Claim-evidence matching and single-issue-single-primary-dimension deduction must remain intact. `image-supplement.md` must never classify or score papers.
- Evidence-ledger IDs, evidence-block numbers, scoring-source tags, stage-audit notes, prompt restatements, manual status names, and repair-template scaffolding are internal provenance only. They must never appear in public analysis prose; also remove duplicated boilerplate introduced by staged or manual repairs.
- Keep placeholder names consistent with the replacement logic in the code.
- After modifying a prompt, it is recommended to run a single-paper analysis or `quick-test.js` to verify the effect.
