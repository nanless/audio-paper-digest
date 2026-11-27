# Legacy-record verification and independent human review

[中文](README.md)

This directory is not an entry point for new paper writing. It serves two purposes: verifying the sources and signatures used by older records, and supporting controlled independent review of current pages. Neither replaces the [daily, conference, and historical workflows](../docs/three-workflows.md).

## What is still supported

The bulk Manual writing pipeline, task assignment, and production of `spec` and `records` have been retired. New work uses the three supported workflows.

First complete a normal round for the selected batch, then continue only failures that are eligible for retry. If a few papers remain after several rounds, choose a controlled correction or independent review under the user's [standing authorization](../AGENTS.md#持续授权以效率和效果为准); do not ask again for each paper. The actual sources, original failed draft, permitted edit scope, costs, and failure records must remain bound and preserved. `manualHandoff` is an advisory report: it does not grant source authority or increase the program's model-request allowance.

The retained modules verify legacy sources, author policies, signatures, articles, and tutorial contracts, and are isolated from the regular API pipelines: `scripts/analysis-contract.js` lazy-loads the 5 retired `manual/scripts/*` contract modules (agent policy, research contract, tutorial-contract orchestrator, fresh-authoring contract, and tutorial payload) on demand, so importing non-manual daily, conference, or historical API paths loads zero `manual/scripts/*` modules. Everyday publishing and the Hugo gate (`scripts/publish-to-blog.py`, `scripts/markdown_hugo_gate.py`, and `scripts/lib/paper-page-staging.js`) import `scripts/tutorial_payload_verifier_core.py`, and retired Manual legacy checks have moved to `scripts/publish_manual_legacy.py`; `manual/scripts/tutorial_payload_verifier.py` remains only as a thin compatibility shim for `manual/scripts/sealed_tutorial_preview.py` and legacy tests. Formal data validation in `scripts/validate-data-files.js` still imports `manual-paper-source-identity.js` and `manual-fresh-authoring-contract.js`, and the independent human-review entry point remains `manual/scripts/manual-review-blog.py`.

What stays read-only is the historical bytes that legacy-record verification reads, not the modules themselves. By measured dependency closure: the daily review protocol closure (`_REVIEW_IMPLEMENTATION_ENTRIES`, which includes `manual/scripts/manual-review-blog.py`) contains 10 `manual/scripts/` modules (excluding `assemble-manual-review-attestation.py`, `manual-signature-contract.js`, `sealed_tutorial_preview.py`, and `tutorial_payload_verifier.py`); the page-renderer `templateFingerprint` contains only 1 `manual/scripts/` module (`manual/scripts/sealed_tutorial_preview.py`) alongside the migrated `scripts/tutorial_payload_verifier_core.py` and `scripts/publish_manual_legacy.py`; non-manual API closures without `manual/` entry points depend on 0 `manual/scripts/` modules. Editing a module inside those closures changes the corresponding fingerprint and requires re-issuing this batch's review receipts. After an edit, run `npm run verify` and rerun the affected reviews in the current batch; passed pages whose bytes did not change are not reviewed again.

Retired contract prompts are no longer in the working tree. Verification retrieves their original bytes through the controlled Git index and checks the originally declared SHA; it does not re-sign old results.

This directory tracks 40 files in Git: 2 READMEs, 14 scripts, 11 JavaScript tests, 7 Python tests, 4 fixtures, and 2 test helpers. Local ignored artifacts (such as `.pyc` files under `__pycache__` or `.DS_Store`) are not repository content and are excluded when counting files here.

## How to read the retained records

For current paper explanations, start with the [project writing guide](../docs/writing-guide.md) and [Reader writing and source requirements](../docs/reader-writing.md). Reader is the long-form explanation intended for readers. Explain a term's role before using its precise name, connect concepts, calculations, comparison conditions, and figures into a complete argument, separate paragraphs with blank lines, and use a plain, calm tone. The permitted scope and budget for controlled revisions remain governed by [Reader recovery](../docs/reader-explicit-retry.md).

The old editorial references and tutorial schema are no longer kept as working-tree instructions. Their original bytes remain in Git objects, registered by logical path, whole-file SHA-256, and actual blob identity in the [original-file evidence catalog](../config/original-file-evidence.json). An old draft can select only registered original bytes for the same path; current guidance or newly edited program files cannot replace its signed inputs.

Terms such as “current,” section requirements, length, and task roles in those historical references apply to their original records. The old JavaScript schema registered there is verified against its original bytes only; modules at the same paths still run in production, so a registered historical SHA that differs from the current file is expected and does not indicate an edit. Use the current writing guide and Reader guide above to learn the present writing requirements.

## Independent review of a current page

New independent reviews must actually use `gpt-6.1-sol` with `high`, a declaration and page identities with their registered schema fingerprints. Record the real subagent identity for every page; entering a model name alone is insufficient. Old `gpt-5.6-terra/high` declarations are accepted only when reading their original records. The governing implementation is `scripts/manual_agent_policy.py`. These review rules do not change the Muse model configured for paper analysis in the three workflows. Analysis manifests follow a separate rule in `manual/scripts/manual-agent-policy.js`, whose current analysis-side identifier is `manual-agents-sol-high-v2`; do not rewrite it using the publication-side rule.

The shared recovery entry points for independent single-page review are:

```bash
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD ...
npm run blog:manual-review -- --date YYYY-MM-DD ...
```

Replace the date and complete `...` with the actual parameters required by each parser and the current page-generation manifest. These examples are not complete commands with invented task materials.

When filling new single-page review materials, `current_review_subagent_fields()` in `scripts/manual_agent_policy.py` supplies the registered format fields. It supplies only the format and required model settings; `taskName`, the page scope, isolated records, and review findings must come from the actual work.

A human content correction must bind this paper's verified sources, the original failed-draft SHA, and an explicit edit scope. After correction, run the normal article, Reader, scoring, tag, source, and publication checks. Actual review and figure evidence must bind the final page bytes. Do not weaken integrity checks, fill in a successful status by hand, or fabricate model-review records.

## Articles and machine-verified assets have different records

An independent review declaration records actual article Markdown semantics and individual-figure review in `files`. A passed page with the same path and content SHA uses actual `cacheReuse` evidence.

For a mixed generation manifest, citation materials, tag-catalog files, and controlled paper figures are recorded separately in `machineAssets`. When issuing the review record and pushing, reconstruct and verify those assets from formal sources and already-reviewed referring pages. The final publication receipt still covers the full manifest.

An internal paper-figure URL is accepted only when its path and byte SHA match a controlled figure in the current manifest; arbitrary relative URLs are not accepted. These assets neither require nor permit fabricated human-review identities. See the [receipt format](../docs/data-format.md#审查记录与远端发布).

Compatibility tests run with `npm run test:compat`. Full acceptance remains `npm run verify`, including tests for the three workflows and legacy-record verification.
