# Legacy-record verification and independent human review

[中文](README.md)

This directory is not an entry point for new paper writing. It serves two purposes: verifying the sources and signatures used by older records, and supporting controlled independent review of current pages. Neither replaces the [daily, conference, and historical workflows](../docs/three-workflows.md).

## What is still supported

The bulk Manual writing pipeline, task assignment, and production of `spec` and `records` have been retired. New work uses the three supported workflows.

First complete a normal round for the selected batch, then continue only failures that are eligible for retry. If a few papers remain after several rounds, choose a controlled correction or independent review under the user's [standing authorization](../AGENTS.md#持续授权以效率和效果为准); do not ask again for each paper. The actual sources, original failed draft, permitted edit scope, costs, and failure records must remain bound and preserved. `manualHandoff` is an advisory report: it does not grant source authority or increase the program's model-request allowance.

The retained modules verify legacy sources, author policies, signatures, articles, and tutorial contracts. They are called by `analysis-contract.js`, formal data validation, and publishing. Retired contract prompts are no longer in the working tree. Verification retrieves their original bytes through the controlled Git index and checks the originally declared SHA; it does not re-sign old results.

## How to read the retained records

For current paper explanations, start with the [project writing guide](../docs/writing-guide.md) and [Reader writing and source requirements](../docs/reader-writing.md). Reader is the long-form explanation intended for readers. Explain a term's role before using its precise name, connect concepts, calculations, comparison conditions, and figures into a complete argument, separate paragraphs with blank lines, and use a plain, calm tone. The permitted scope and budget for controlled revisions remain governed by [Reader recovery](../docs/reader-explicit-retry.md).

The old editorial references and tutorial schema are no longer kept as working-tree instructions. Their original bytes remain in Git objects, registered by logical path, whole-file SHA-256, and actual blob identity in the [original-file evidence catalog](../config/original-file-evidence.json). An old draft can select only registered original bytes for the same path; current guidance or newly edited program files cannot replace its signed inputs.

Terms such as “current,” section requirements, length, and task roles in those historical references apply to their original records. The old JavaScript schema is read as byte evidence and is never executed. Use the current writing guide and Reader guide above to learn the present writing requirements.

## Independent review of a current page

New independent reviews must actually use `gpt-6.1-sol` with `high`, a declaration and page identities with their registered schema fingerprints. Record the real subagent identity for every page; entering a model name alone is insufficient. Old `gpt-5.6-terra/high` declarations are accepted only when reading their original records. The governing implementation is `scripts/manual_agent_policy.py`. These review rules do not change the Muse model configured for paper analysis in the three workflows.

The shared recovery entry points for independent single-page review are:

```bash
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD ...
npm run blog:manual-review -- --date YYYY-MM-DD ...
```

Replace the date and complete `...` with the actual parameters required by each parser and the current page-generation manifest. These examples are not complete commands with invented task materials.

A human content correction must bind this paper's verified sources, the original failed-draft SHA, and an explicit edit scope. After correction, run the normal article, Reader, scoring, tag, source, and publication checks. Actual review and figure evidence must bind the final page bytes. Do not weaken integrity checks, fill in a successful status by hand, or fabricate model-review records.

## Articles and machine-verified assets have different records

An independent review declaration records actual article Markdown semantics and individual-figure review in `files`. A passed page with the same path and content SHA uses actual `cacheReuse` evidence.

For a mixed generation manifest, citation materials, tag-catalog files, and controlled paper figures are recorded separately in `machineAssets`. When issuing the review record and pushing, reconstruct and verify those assets from formal sources and already-reviewed referring pages. The final publication receipt still covers the full manifest.

An internal paper-figure URL is accepted only when its path and byte SHA match a controlled figure in the current manifest; arbitrary relative URLs are not accepted. These assets neither require nor permit fabricated human-review identities. See the [receipt format](../docs/data-format.md#审查记录与远端发布).

Compatibility tests run with `npm run test:compat`. Full acceptance remains `npm run verify`, including tests for the three workflows and legacy-record verification.
