# Default LLM/API architecture

Each component reads and writes a fixed set of files; per-paper analysis resumes from saved checkpoints; and publication verifies page files and Git state. Commands are in [Scripts](scripts.md) and saved fields in [Data formats](data-format.md). The [Manual subsystem](../../manual/README.md) applies only to explicitly requested human processing.

## Components

```text
run-daily-digest.sh
  ├─ full-fetch.js
  │    ├─ arXiv / HuggingFace acquisition and LLM filtering
  │    ├─ daily-fresh-source-plan.js → official text/PDF source files
  │    └─ analysis-engine.js → deep-analyzer.js
  ├─ generate-blog.py → pages
  ├─ review-blog.py → deterministic, LLM, image, and Hugo checks
  ├─ push-blog.py → exact Git delta and remote OID verification
  └─ visual planners → Codex image_gen → inspection, record, and status
```

Node owns fetching, filtering, daily source capture, per-paper analysis, checkpoints, and visual tasks. Python owns page generation, read-only review, Hugo checks, and the Git publication transaction. The Hugo repository is a publication target, not a source of analysis facts. Uncommitted pages cannot change the deduplication baseline used during filtering.

Node and Python share account selection and cooldown state in `data/runtime/llm-account-pool.json`. These request states stay out of paper, prompt, and publication-content fingerprints. The file holds no raw key, but its credential fingerprints are still sensitive, so keep it at `0600`.

Project scripts only prepare, check, and record visual inputs and results. Only Codex's built-in image tool produces final art.

## Per-paper analysis DAG

```text
saved source files
  → primary analysis
  → project/demo evidence
  → revision and table/method/structure repairs
  → tag and core-summary checks
  → scoring audit
  → API Reader article and official paper figures
  → optional legacy image supplement
```

After LLM filtering and before analysis, every selected arXiv ID refetches official HTML text and PDF and atomically saves the four-file `daily-fresh-source-run-v1` bundle. Analysis, Reader, and Python publication all revalidate the files that `dailyFreshSourceRun` names. Missing files or a SHA mismatch stop the run before any model or figure request. A source `generation` identifies one captured file set. It is not the paper revision `vN`. Citations must use the version the saved record actually establishes.

Official figure pixels are prepared in the system temporary directory for the current call only. They stay out of `data/current` and out of runtime image caches. A figure over the limit may be skipped. When the provider explicitly rejects a PNG as corrupt or incompatible, the run may convert it to a white-background RGB JPEG and retry. The final evidence records the pixel SHA actually sent to the model.

Each stage saves its input fingerprint, model and protocol, prompt SHA, evidence budget, output SHA, and final state. Change an input and only the affected stage is invalidated, along with everything downstream. A normalized arXiv-ID lock protects each paper. Merging requires rereading the accepted analysis record inside that lock, because a stale object read outside it must not overwrite.

Model output has token, elapsed-time, and response-byte limits, and Node analysis also checks that streamed responses end correctly. Node and Python both check the response terminal state before accepting text: Responses `incomplete/failed/cancelled`, Chat `length`, and Anthropic `max_tokens` do not count as success, even when the text happens to be complete JSON. Python keeps a bounded recovery only for responses that originally had no text and spent their output budget on hidden reasoning. A rejected nonempty body gets no such recovery.

Node's `analyzeBatch` stops claiming new papers on run-level errors such as failed authentication or an unusable account pool. Papers already started still save their results, and papers not yet started stay pending. The batch entry reports the failure after its final save. An ordinary per-paper error ends only that paper's attempt. Python page review submits its thread tasks before collecting results, so it does not inherit Node's stop-dispatch behavior.

API Reader draws its facts from the saved source text, structured evidence, verified resources, and the figures prepared for this call, never from scored analysis prose. The parser still reads the older 13-section analysis. Running Reader after scoring does not make the score part of its writing input.

Each Reader protocol checks a different object:

| Protocol | Scope |
|---|---|
| `beginner-researcher-v3` | Article structure and length |
| `api-reader-source-bindings-v4` | Each table cell maps to an original cell or exact quote; display formulas come from structured original TeX |
| `api-reader-author-identity-v1` | Authors and affiliations map to HTML, paper metadata, or an explicit unavailable state |
| `api-reader-resource-identity-v1` | Source/demo evidence, redirect destinations, and resource availability |

Structured evidence is hashed over a stable key order. Older structured files require checks of the source manifest, original full-text SHA, parser version, and layout. Restricted v1 sources without layout include `fresh_arxiv_text_without_layout`, `direct_conference_pdf_text`, and `conference_pdf_weak_text` with `weak-text-only-v1` capability; their tables, formulas, and figures arrays must all be empty. A recognized older key order is still bound by the source manifest and original full-text SHA, and its old `payloadSha256` need not equal the value recomputed in the current stable key order. The program computes a stable fingerprint in memory only and never rewrites saved files. Nothing in this exception permits fabricated structured content.

Stage reuse also depends on implementation SHA. Reader checks currently include the SHA of the whole `deep-analyzer.js`, so touching code there that has nothing to do with Reader may still force another run. Unchanged scoring alone is not enough to reuse Reader output.

## Publication transaction

```text
accepted batch input
  → generation manifest v3 and exact page bytes
  → immutable page review artifacts
  → deterministic, LLM, and image review
  → isolated Hugo check
  → review receipt bound to page SHA and Git baseline
  → exact commit → push → live remote-main OID verification
  → post-publication visual tasks
```

Review leaves reviewed pages untouched. Fixes go back to generation or analysis. Push accepts only the exact additions, modifications, and deletions the receipt lists. Any Git hook change, extra staged file, baseline mismatch, timeout, or remote identity change blocks it.

A passed page review is reused permanently by "relative path + page content SHA", and only a change to that SHA triggers another review. A publisher implementation change still rerenders, so real byte changes show up. A manifest, model, code, protocol, or Hugo change means you must rerun the current batch checks and create a new receipt, but unchanged pages stay out of review. Analysis-stage implementation SHA and this page-cache rule work separately; do not mix them.

The remote OID proves only that the Git commit reached the remote. Before calling the batch done, a human must also confirm that the build/deploy for that publication commit, or for a later commit that preserves the reviewed page bytes, succeeded. Check HTTP 200, the official address, and the title of the dated digest and every paper page, and keep the records. `digest:status` does not yet perform these live checks.

## Runtime ownership

| Location | Contents |
|---|---|
| `data/current/` | Active batch state and resumable checkpoints |
| `data/archive/<date>/` | Closed-date snapshots and final visual assets |
| `data/runtime/daily-fresh-source-runs/` | Official text, PDF, runtime record, and manifest for daily analysis and publication |
| `data/runtime/fetched-arxiv-sources/` | Newly captured source-file sets for historical arXiv rewriting |
| Hugo repository | Generated pages, static assets, and verified publication commits |
| `logs/` | Redacted diagnostics under age and capacity retention rules |

An existing file does not mean the stage is complete. Consumers check dates, paper sets, state, input fingerprints, and SHA. Historical snapshots are usable for recovery only after they pass the cross-file checks, and they never excuse a current batch failure.

## Lock boundaries

| Lock | Protects | Recovery |
|---|---|---|
| full-fetch run lock | Archiving, fetching, filtering, and batch initialization | Never delete a live holder; after it exits, reclaim by the holder and lease rules |
| paper analysis lock | One paper's checkpoints and merge into accepted analysis | Wait for the running task; reread inside the lock, and never let a stale object overwrite |
| JSON file lock | Shared files such as `papers.json`, deep analysis, and manifests | Read-modify-write in one step and increment `generation` |
| LLM account pool lock | Account selection and cooldown state across dates | Held briefly for account selection or quota confirmation; HTTP requests always run outside it |
| blog repository/date lock | Page generation, review, Git index, commit, and push | Check the holder and child processes; never delete a live lock |

While a lock is waiting, check the owner PID, hostname, heartbeat, and child processes. A lock may be reclaimed only when the implementation confirms that its lease and holder meet the stale conditions. A slow command is no reason to delete it.

## Network boundary

- A network or API failure never switches the run to Manual.
- Muse, arXiv, HuggingFace, and paper assets each follow their own project proxy rules; an ordinary LLM does not inherit that proxy.
- Shared LLM requests and primary analysis carry their configured byte and elapsed-time limits; each optional script sets its own.
- External assets are HTTPS-only: redirects reject private and reserved destinations, pin a validated public IP, and keep the original Host and TLS SNI.
- OpenCode Go advances to a later account only for an explicit HTTP 429 `GoUsageLimitError` or an HTTP 401 `Insufficient balance` on the same route. An ordinary authentication 401 stops the run, and ordinary 429, 5xx, and network failures do not switch accounts. A successful account stays selected, and an older account leaving cooldown does not switch it back. Before attaching credentials, the request verifies that its real URL exactly matches the value derived from endpoint/model, and different services cannot share the primary account pool.
- Analysis SHA checks byte identity. Source checks establish that a table, formula, or claim really comes from the paper. Publication checks pages, receipts, Git commits, and remote state as well.
- A new source capture sequence number must be revalidated against the current files. A historical page stays readable, but an old Reader version number does not give it publication eligibility again.
- Historical `direct-local-first` prepares sources, analysis, and private pages on its own, then reviews and publishes through `history:direct-publication`. Every arXiv round refetches official text/PDF, and conference entries revalidate retained local metadata/PDF. The fallback `history:arxiv-batch` accepts only named fresh-arXiv acquisition-failure handoffs. `history:crosswalk` still supports explicit older-state maintenance under source-authorization and CAS checks, and normal direct work never depends on it. The older `history:publication` still only produces private files, with no such publish stage.
- A visual failure does not revoke a verified blog publication. Full completion still requires data, review, remote, deployment, and page checks, plus finished images or a valid user waiver that covers visuals alone.
