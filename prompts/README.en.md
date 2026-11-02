# Prompts for paper processing

[中文](README.md) · [Project documentation](../docs/README.md) · [Reader writing guide](../docs/reader-writing.md)

This directory contains the 18 prompt templates currently used by the program. Each template specifies the available material, the task, the output structure, and the limits that still apply when evidence is missing or a repair fails. These are not steps to run in sequence: the program chooses stages according to the workflow, saved progress, and actual errors.

This page is for people maintaining templates or investigating model inputs. For guidance on explaining a paper, start with [Clear technical writing](../skills/clear-technical-writing/SKILL.md), the [project writing conventions](../docs/writing-guide.md), and the [Reader writing guide](../docs/reader-writing.md). To run a daily digest, conference workflow, or historical update, use the [project operating guide](../SKILL.md). Do not launch production by selecting a template directly from this directory. These linked reference guides are in Chinese.

## How a template becomes a request

The [JavaScript version registry](../scripts/lib/prompt-text-versions.js) selects 15 general templates, including filtering. Three additional templates handle facts or terminology within an explicitly established scope. The [Python current-template list](../scripts/prompt_evidence.py) must match this registry.

The loader reads only the first fenced code block and replaces placeholders such as `{title}` with material for the request. Placeholders are program interfaces, so their names must remain exact. Explanatory text outside that block is not sent to the model, but it is included when checking the exact bytes of the whole file. It cannot be edited without following the versioning rules.

A request may also include current quantity requirements, the images actually supplied, feedback, or instructions for a restricted operation. These additions are bound to the input identity and original request records. A field example or local path in documentation does not establish that the model has received that source, and it does not expand the permitted changes.

## Find the current template by task

### Paper selection, analysis, and scoring

| Task | Current file | Main output or scope |
|---|---|---|
| Decide whether a paper concerns speech, music, or audio | [filter-v5.md](filter-v5.md) | A fixed-format reason and decision, not a full analysis |
| Analyze the full text | [deep-analysis-v8.md](deep-analysis-v8.md) | Analysis, machine summary, tags, and scoring material in 13 fixed sections |
| Review the analysis against the source | [gap-fill-v5.md](gap-fill-v5.md) | A complete replacement in the original section structure, checking facts and scores |
| Independently review scoring | [scoring-audit-v5.md](scoring-audit-v5.md) | Structured scores, reasons, and evidence; no article changes |
| Write the blog explanation | [api-reader-article-v11.md](api-reader-article-v11.md) | A complete Reader writing plan for subsequent assembly and validation |

Daily and conference filtering share the filter template; each entry point supplies its own source and conference configuration. Daily digests, conferences, and historical updates share Reader writing and parsing requirements, while validating their sources, run identities, and recovery entry points separately. By default, Reader writes the blog article independently from the paper source instead of copying the primary analysis.

### Fill specific gaps in the analysis

| Task | Current file | Change boundary |
|---|---|---|
| Extract open-source and reproduction information | [opensource-scan-v3.md](opensource-scan-v3.md) | Copy actual resource URLs verbatim; code checks reachability separately |
| Add experimental tables | [table-fill-v2.md](table-fill-v2.md) | Return only the experimental-results section; invent neither numbers nor images |
| Explain the method in more detail | [method-fill-v3.md](method-fill-v3.md) | Return only the method-and-architecture section |
| Correct classification tags | [tag-repair-v3.md](tag-repair-v3.md) | Select concepts from the supplied vocabulary; do not change article text |
| Repair the core summary | [core-summary-repair-v7.md](core-summary-repair-v7.md) | Change only the core summary, preserving the other 12 sections |
| Repair analysis structure | [structure-repair-v4.md](structure-repair-v4.md) | Repair only the section boundaries or content problems identified by feedback |
| Repair specified Reader targets | [api-reader-repair-v13.md](api-reader-repair-v13.md) | Return a bounded patch checked against the original draft and target SHAs; no default full rewrite |

Primary analysis and tag repair use the current 386-concept vocabulary and select only direct tags supported by this paper. The existing requirements remain: 3–5 tags, a primary task and method, and the prescribed JSON or four-line text format. The publisher derives parent navigation from the same vocabulary. The model must not output the entire taxonomy or add ancestors to fill the direct-tag count. Directions with zero papers may remain in the directory without being assigned to a paper artificially.

### Original figures and targeted corrections

| Task | Current file | Conditions |
|---|---|---|
| Select original paper figures and explain how to read them | [image-supplement-v3.md](image-supplement-v3.md) | Use only candidate images whose pixels were actually supplied; preserve the analysis |
| Correct a local primary-analysis fact | [primary-fact-local-repair-v1.md](primary-fact-local-repair-v1.md) | Change only original paragraphs explicitly permitted by source-bound feedback |
| Correct a Reader sentence | [api-reader-fact-local-v3.md](api-reader-fact-local-v3.md) | Replace only an authorized complete erroneous sentence, preserving surrounding characters and other fields |
| Correct a name in a concept group | [api-reader-concept-terms-v1.md](api-reader-concept-terms-v1.md) | Use only when the program establishes that term length is the sole blocker |
| Plan a visual paper summary | [visual-summary-v2.md](visual-summary-v2.md) | Retained for future visual tasks explicitly requested by the user |
| Plan a digest cover | [digest-cover-v2.md](digest-cover-v2.md) | Retained for future visual tasks explicitly requested by the user |

The user's standing instruction is that daily digests must no longer generate images. They generate neither visual paper summaries nor digest covers, and do not run `visual:prepare` or invoke image-generation tools. Fetching original paper figures, validating their sources, displaying them in articles, and reviewing them continue normally. Retaining the two visual templates and their historical identities does not re-enable daily image generation.

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

The program registry determines current paths. A filename does not always equal the protocol version: `structure-repair-v4.md`, for example, corresponds to `analysis-prompt-text-v5`. Update current links when documenting the current template, but retain original versions when describing historical records.

Before changing any template bytes, including text outside the fence, follow the [prompt-change rules](../docs/maintenance.md#prompt-修改): create a new version, compare old and new placeholders and output structures, and synchronize version registration, historical evidence, and relevant tests. Do not upgrade already-correct rules just to increase the number of edits. Check every list actually read by JavaScript, Python, and selected full-stage reanalysis; updating one registry is insufficient.

Retired templates are absent from the working tree. The [historical evidence index](../scripts/lib/git-prompt-evidence-index.json) records their original paths, Git object IDs, and whole-file SHAs. The reading code checks the SHA of the whole file and the template inside its first code block. Missing objects or different bytes stop verification; a reconstructed approximation cannot stand in for the original. Preserve declarations, paper sources, drafts, request counts, costs, and recovery scopes. An upgrade must not re-sign old drafts, erase accounting, or reset failures.

An unfinished old conference Reader may be revalidated read-only using its original template declaration after its original request, response, usage, and paper source are all verified. This entry point prohibits model requests. Old Manual templates also serve only to verify original records; bulk Manual production is retired.

Historical evidence reading requires Git 2.45 or newer and complete repository history. CI uses a full checkout. The reader accesses only local original objects and does not fetch missing objects itself. If a shallow clone lacks them, synchronize complete history before retrying verification. Do not materialize retired templates in the working tree.
