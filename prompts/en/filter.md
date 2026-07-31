# Filter Prompt — Determine if a Paper is Related to Speech / Music / Audio

## Purpose
Used during the LLM filtering stage to determine whether a single paper is related to speech, audio, or sound processing.

## Invocation
The code reads this file and replaces placeholders with actual values:
- `{title}` → paper title
- `{abstract}` → paper abstract
- `{categories}` → arXiv categories (e.g., cs.SD, eess.AS, cs.CL, comma-separated)

## Prompt Content

```
Please determine whether the following paper is related to speech, audio, or sound processing.

Paper Title: {title}
Paper Abstract: {abstract}
arXiv Categories: {categories}

Criteria (if any one is met, classify as "related"):
1. The paper's core task is speech/music/audio processing: automatic speech recognition (ASR), text-to-speech (TTS), speech enhancement, speech separation, voice conversion, sound source localization, audio classification, audio event detection, music generation/understanding, bioacoustics, etc.
2. The paper's core task is speaker-related: speaker recognition, speaker verification, speaker diarization, voiceprint recognition, speech emotion recognition, etc.
3. The paper studies a multimodal model/system, and speech or audio is one of the modalities (as input, output, training target, evaluation dimension, or core capability).
4. The paper studies representation learning, feature extraction, codec, or pre-trained models for speech/music/audio signals.

Explicit exclusions (classify as "not related"):
- Pure natural language processing: intent understanding, text classification, machine translation, text generation, QA systems, knowledge graphs — even if the model name contains "multimodal" but the abstract makes no mention of speech/music/audio.
- Pure computer vision: image classification, object detection, image generation, video understanding — unless the paper explicitly states that audio in the video is the core research focus.
- General large language model evaluation: evaluating only text capabilities (e.g., MMLU, GSM8K, HumanEval), even if the model claims to be "multimodal" but the evaluation does not involve speech/music/audio tasks.
- General machine learning theory: optimization theory, neural network scaling laws, equivariant network mathematical frameworks, etc. — unless the core contribution specifically targets the properties of speech/music/audio signals.

Auxiliary reference (arXiv category hints):
- cs.SD (Sound), eess.AS (Audio and Speech Processing) → highly related
- cs.CL (Computation and Language) → needs combined judgment with title/abstract; may be pure NLP
- cs.CV (Computer Vision) → needs combined judgment with title/abstract; may be pure CV
- cs.LG (Machine Learning) → needs combined judgment with title/abstract; may be general ML theory

Please output in the following fixed format; do not add or remove any formatting:

Reason: [1-2 sentences explaining the basis for the judgment]
Conclusion: [related / not related]

Example 1:
Reason: This paper studies speech synthesis; the core task is audio generation, directly related to speech.
Conclusion: related

Example 2:
Reason: This paper is pure text classification; the abstract contains no mention of speech or audio.
Conclusion: not related

Example 3:
Reason: This paper evaluates multimodal large models, and speech understanding is one of the core evaluation dimensions.
Conclusion: related

Example 4:
Reason: This paper studies general neural network scaling laws; speech is only one of the validation modalities, and the core contribution does not target speech properties.
Conclusion: not related

Important: You must output "Conclusion: related" or "Conclusion: not related".
```

## Output Requirements
The model must output "Conclusion: related" or "Conclusion: not related". The code parses the output with the following priority:
1. JSON fields `decision` / `related` / `conclusion` (`related` / `not_related`)
2. Structured conclusion lines: `Conclusion/Judgment/Related: related|not related|yes|no`
3. Match whether the last line is "related" / "not related" / "yes" / "no"
4. If none of the structured forms can be parsed, phrase matches are only hints for the controlled format-repair pass and do not become definitive decisions
5. If format repair still cannot produce a fixed conclusion, mark the paper retryable; the filter artifact cannot be complete until every candidate has a definitive decision

The keyword prefilter follows a high-recall contract: core audio categories, abstracts shorter than 80 characters, and papers matching an audio term family must reach the LLM. Even when an abstract contains withdrawn/retracted, core-category and short-abstract papers cannot bypass those fail-open rules. Only supplemental-category papers with a complete abstract and no term match may receive a deterministic negative decision.
