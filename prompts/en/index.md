# Prompt Documentation Index

This directory contains all LLM prompts for the audio-paper-digest skill, separated from code to enable independent iteration.

## Document List

| File | Purpose | Called From |
|------|---------|-------------|
| [filter.md](filter.md) | Filtering stage: determine whether a single paper is related to speech / music / audio | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | Deep analysis stage (round 1, text-only): read full text and output structured report | `deep-analyzer.js` |
| [opensource-scan.md](opensource-scan.md) | Open-source scan stage (round 2): specifically extract open-source links and reproduction information | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | Deep analysis stage (round 3): review and rewrite the earlier rounds' results against the original text | `deep-analyzer.js` |

> Note: `image-supplement.md` (dual-model mode — the secondary model reads figures to supplement the primary model's analysis) has **no English version**; the code always loads the Chinese `prompts/image-supplement.md`. See the Chinese [prompts/index.md](../index.md).

## Placeholder Conventions

Template placeholders in each prompt are denoted by `{variableName}`; the code injects actual values via string replacement after reading the file. See the "Invocation" section in each document for specific placeholders.

## Loading Rules

- `loadPrompt()` reads only the first fenced code block in the markdown file as the runtime prompt.
- If the prompt body itself needs to show code fences, the outer fenced block must use a longer fence such as ```` or `~~~~`, otherwise the first inner ``` block will truncate the loaded prompt.
- When adding a `{variableName}` placeholder, update the calling code and tests at the same time. Unreplaced placeholders currently produce warnings rather than automatically stopping the pipeline.

## Modification Suggestions

- When adjusting the tag system, scoring criteria, or output format, simply edit the corresponding markdown file; no code changes are needed.
- Keep placeholder names consistent with the replacement logic in the code.
- After modifying a prompt, it is recommended to run a single-paper analysis or `quick-test.js` to verify the effect.
