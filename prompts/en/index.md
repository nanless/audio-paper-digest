# Prompt Documentation Index

This directory contains all LLM prompts for the audio-paper-digest skill, separated from code to enable independent iteration.

## Document List

| File | Purpose | Called From |
|------|---------|-------------|
| [filter.md](filter.md) | Filtering stage: determine whether a single paper is related to speech / music / audio | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | Deep analysis stage (round 1): read full text + figures and output structured report | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | Deep analysis stage (round 3): review and rewrite the first two rounds' results against the original text | `deep-analyzer.js` |
| [opensource-scan.md](opensource-scan.md) | Open-source scan stage (round 2): specifically extract open-source links and reproduction information | `deep-analyzer.js` |

## Placeholder Conventions

Template placeholders in each prompt are denoted by `{variableName}`; the code injects actual values via string replacement after reading the file. See the "Invocation" section in each document for specific placeholders.

## Modification Suggestions

- When adjusting the tag system, scoring criteria, or output format, simply edit the corresponding markdown file; no code changes are needed.
- Keep placeholder names consistent with the replacement logic in the code.
- After modifying a prompt, it is recommended to run a single-paper analysis or `quick-test.js` to verify the effect.
