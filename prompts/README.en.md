# Prompts for paper processing

[中文](README.md) · [Project documentation](../docs/README.md) · [Reader writing guide](../docs/reader-writing.md)

`current/` contains the 16 prompt templates currently used by the program. Each template specifies the available material, the task, the output structure, and the limits that still apply when evidence is missing or a repair fails. These are not steps to run in sequence: the program chooses stages according to the workflow, saved progress, and actual errors.

This page is for people maintaining templates or investigating model inputs. For guidance on explaining a paper, start with [Clear technical writing](../skills/clear-technical-writing/SKILL.md), the [project writing conventions](../docs/writing-guide.md), and the [Reader writing guide](../docs/reader-writing.md). To run a daily digest, conference workflow, or historical update, use the [project operating guide](../SKILL.md). Do not launch production by selecting a template directly from this directory. These linked reference guides are in Chinese.

## How a template becomes a request

The current templates are registered in the [current-template record](../scripts/lib/prompt-current-records.json): 12 analysis stages and 1 filter template, plus 3 fact- and terminology-repair templates used only within an explicitly established scope, 16 in total. The [JavaScript registry](../scripts/lib/prompt-contracts.js) and the [Python current-template list](../scripts/prompt_evidence.py) both read this file, so the two lists must match; `npm test` pins the registered total at 16 and checks that `current/` matches the registry one to one.

The loader reads only the first fenced code block and replaces placeholders such as `{title}` with material for the request. The first fence marker may be empty or `text`; any other value such as `json` fails immediately, so the prose after the block is never mistaken for the template. Placeholders are program interfaces, so their names must remain exact; a placeholder with no supplied value produces a warning, and the program does not fill it in. Explanatory text outside that block is not sent to the model, but it is included when checking the exact bytes of the whole file. It cannot be edited without following the versioning rules.

A request may also include current quantity requirements, the images actually supplied, feedback, or instructions for a restricted operation. These additions are bound to the input identity and original request records. A field example or local path in documentation does not establish that the model has received that source, and it does not expand the permitted changes.

## Find the current template by task

### Paper selection, analysis, and scoring

| Task | Current file | Main output or scope |
|---|---|---|
| Decide whether a paper concerns speech, music, or audio | [filter.md](current/filter.md) | A fixed-format reason and decision, not a full analysis |
| Analyze the full text | [deep-analysis.md](current/deep-analysis.md) | Analysis, machine summary, tags, and scoring material in 13 fixed sections |
| Review the analysis against the source | [gap-fill.md](current/gap-fill.md) | A complete replacement in the original section structure, checking facts and scores |
| Independently review scoring | [scoring-audit.md](current/scoring-audit.md) | Structured scores, reasons, and evidence; no article changes |
| Write the blog explanation | [api-reader-article.md](current/api-reader-article.md) | A complete Reader writing plan for subsequent assembly and validation |

Daily and conference filtering share the filter template; each entry point supplies its own source and conference configuration. Daily digests, conferences, and historical updates share Reader writing and parsing requirements, while validating their sources, run identities, and recovery entry points separately. By default, Reader writes the blog article independently from the paper source instead of copying the primary analysis.

### Fill specific gaps in the analysis

| Task | Current file | Change boundary |
|---|---|---|
| Extract open-source and reproduction information | [opensource-scan.md](current/opensource-scan.md) | Copy actual resource URLs verbatim; code checks reachability separately |
| Add experimental tables | [table-fill.md](current/table-fill.md) | Return only the experimental-results section; invent neither numbers nor images |
| Explain the method in more detail | [method-fill.md](current/method-fill.md) | Return only the method-and-architecture section |
| Correct classification tags | [tag-repair.md](current/tag-repair.md) | Select concepts from the supplied vocabulary; do not change article text |
| Repair the core summary | [core-summary-repair.md](current/core-summary-repair.md) | Change only the core summary, preserving the other 12 sections |
| Repair analysis structure | [structure-repair.md](current/structure-repair.md) | Repair only the section boundaries or content problems identified by feedback |
| Repair specified Reader targets | [api-reader-repair.md](current/api-reader-repair.md) | Return a bounded patch checked against the original draft and target SHAs; no default full rewrite |

Primary analysis and tag repair use the current 386-concept vocabulary and select only direct tags supported by this paper. The existing requirements remain: 3–5 tags, a primary task and method, and the prescribed JSON or four-line text format. The publisher derives parent navigation from the same vocabulary. The model must not output the entire taxonomy or add ancestors to fill the direct-tag count. Directions with zero papers may remain in the directory without being assigned to a paper artificially.

### Original figures and targeted corrections

| Task | Current file | Conditions |
|---|---|---|
| Select original paper figures and explain how to read them | [image-supplement.md](current/image-supplement.md) | Use only candidate images whose pixels were actually supplied; preserve the analysis |
| Correct a local primary-analysis fact | [primary-fact-local-repair.md](current/primary-fact-local-repair.md) | Change only original paragraphs explicitly permitted by source-bound feedback |
| Correct a Reader sentence | [api-reader-fact-local.md](current/api-reader-fact-local.md) | Replace only an authorized complete erroneous sentence, preserving surrounding characters and other fields |
| Correct a name in a concept group | [api-reader-concept-terms.md](current/api-reader-concept-terms.md) | Use only when the program establishes that term length is the sole blocker |

The user's standing instruction is that daily digests must no longer generate images. They generate neither visual paper summaries nor digest covers, and provide no image-generation task entry point or image-generation tool calls. Fetching original paper figures, validating their sources, displaying them in articles, and reviewing them continue normally. The two visual templates have been removed from the working tree and current registry, keeping only their original Git bytes for verifying historical records and no writing entry point: `visual-summary` was the long-figure template and `digest-cover` the digest-cover template, and their original paths are recorded in the [retired-template record](../scripts/lib/prompt-legacy-records.json). `image-supplement.md` in the table above is not part of that retirement; it only selects original paper figures from the pixels actually supplied for this request and explains how to read them.

## Explain clearly without changing the output protocol

For beginners, establish the task, objects, and necessary background before explaining how key steps turn inputs into outputs. Explain what a term does. Do not add English where ordinary Chinese is sufficient; preserve necessary official names, code fields, and abbreviations accurately. Near each comparison, state the objects, setup, metric, units, numerical direction, and cost. Explain actual operations in formulas and what is genuinely visible in the supplied original figures.

Organize paragraphs around questions and explanatory steps. Start a new paragraph when moving to a different step, evidence, or inference. Leave blank lines between headings, prose, lists, tables, and markers. In JSON text strings, use valid `\n\n` escapes for blank lines. Do not put checking instructions, source fields, or editorial procedures into the blog article.

These writing practices do not change machine outputs. Filtering still returns a fixed decision, tagging returns its prescribed fields, and scoring returns structured records. Restricted repairs change only the permitted targets. Original tables, TeX, verbatim quotations, fields, placeholders, and markers remain protected by their protocols. When a summary selects a few key result groups, each group must still retain both comparable values, units, precision, conditions, and necessary costs. A limit on groups is not a limit on the number of numerical values.

## Keep normal table sources separate from recovery material

Initial Reader writing uses only the full text supplied for that request and images actually received. Use `selection` for original tables whose rows and columns can safely be selected. Use `completeTable` according to the complete-matrix rules when retaining the whole table. Continuous result sentences in the ordinary full text can be bound with `source_quotes`. See the [Reader table rules](../docs/reader-writing.md#表格和公式) for output forms and cell-by-cell source requirements.

`source_quotes` may add `pdfSourceQuotes` only when both conditions hold: the current controlled recovery actually supplies the complete text extracted from an independent official PDF, preserving its original characters, and explicitly permits this quotation operation. That PDF must be the preserved source file whose exact bytes have been verified. A path, field example, caption, pixels, or earlier PDF evidence replaces neither the material required for this request nor the permitted scope. The program creates the evidence field `sealedPdfQuoteEvidence` after verification; the model must not fill it in. Changing source-field forms must not bypass checks on numbers, units, or comparison conditions.

When daily Reader repairs ordinary existing fields through Responses, the program may generate runtime instructions using a target number, `targetOrdinal`, and a short token, `requestToken`. It then compiles the result into a patch checked against the original field SHAs. Special repairs retain their own rules. Runtime prompts have separate identities and actual request records; they add neither directory templates nor allowance to the original window.

The shared publisher builds page inputs for publication review and uses shared model-request wrappers. Publication review is not another writing template in this directory. Old drafts resume from their original saved progress and corresponding entry points; changing a template does not create a new content allowance.

## Change templates and verify old records

Current templates use stable filenames under `current/`. New requests use an unnumbered prompt contract and record the actual content fingerprint. Neither a filename nor a contract name replaces content verification. Historical records still select their original paths, declarations, and SHAs.

Before changing any template bytes, including text outside the fence, preserve the original Git object and whole-file SHA. Then follow the [prompt-change rules](../docs/maintenance.md#prompt-修改) to edit the current template at its stable path. Compare placeholders and output structures, and synchronize content evidence, the shared registry, and relevant tests. Do not add a filename number to represent a change, or edit already-correct rules merely to increase the edit count. JavaScript, Python, and selected full-stage reanalysis share the current registry. A centralized reader verifies historical formats and original budgets; old drafts do not acquire new request allowances.

Retired templates are absent from the working tree. The [historical evidence index](../scripts/lib/git-prompt-evidence-index.json) records their original paths, Git object IDs, and whole-file SHAs. The reading code checks the SHA of the whole file and the template inside its first code block. Missing objects or different bytes stop verification; a reconstructed approximation cannot stand in for the original. Preserve declarations, paper sources, drafts, request counts, costs, and recovery scopes. An upgrade must not re-sign old drafts, erase accounting, or reset failures.

An unfinished old conference Reader may be revalidated read-only using its original template declaration after its original request, response, usage, and paper source are all verified. This entry point prohibits model requests. Old Manual templates also serve only to verify original records; bulk Manual production is retired.

Historical evidence reading requires Git 2.45 or newer and complete repository history. CI uses a full checkout. The reader accesses only local original objects and does not fetch missing objects itself. If a shallow clone lacks them, synchronize complete history before retrying verification. Do not materialize retired templates in the working tree.
