# Default LLM/API architecture

This page explains what each component reads and writes, how per-paper analysis resumes, and how publication checks page files and Git state. See [Scripts](scripts.md) for commands, [Data formats](data-format.md) for saved fields, and the [Manual subsystem](../../manual/README.md) only for explicitly requested human processing.

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

Node owns fetching, filtering, daily source capture, analysis checkpoints, accepted analysis records, and visual tasks. Python owns page generation, read-only review, Hugo checks, and the Git publication transaction. The Hugo repository is a publication target, never a source of analysis facts. Uncommitted pages cannot alter the deduplication baseline used for filtering.

Node and Python share account selection and cooldown state in `data/runtime/llm-account-pool.json`. These request states do not enter paper, prompt, or publication-content fingerprints. The file contains no raw key, but its credential fingerprints remain sensitive and require `0600` permissions.

Project scripts prepare, check, and record visual inputs and results. Only Codex's built-in image tool creates final art.

## Per-paper analysis DAG

```text
sealed source files
  → primary analysis
  → project/demo evidence
  → revision and table/method/structure repairs
  → taxonomy and core-summary checks
  → scoring audit
  → API Reader article and official paper figures
  → optional legacy image supplement
```

After filtering and before analysis, every selected arXiv ID captures official HTML text and PDF into the four-file `daily-fresh-source-run-v1` bundle. Analysis, Reader, and Python publication revalidate the files selected by `dailyFreshSourceRun`. Missing files or a SHA mismatch stop the operation before model or figure requests. A source `generation` identifies one captured file set; it is distinct from the paper revision `vN`. Citations must use the revision established by the saved source record.

Official figure pixels exist only in the active call's system temporary directory. They cannot become a `data/current` or runtime image cache. An oversized figure may be skipped. A PNG explicitly rejected by the provider as corrupt or incompatible may be converted to a white-background RGB JPEG and retried; the evidence then records the actual input-pixel SHA.

Each stage records its input fingerprint, model and protocol, prompt SHA, evidence budget, output SHA, and final state. Input changes invalidate the affected stage and its downstream stages. A normalized arXiv-ID lock protects each paper; merging requires rereading the accepted record inside that lock.

Model output has token, elapsed-time, and response-byte limits. Node analysis also checks that streamed responses end correctly. Node and Python check response state before accepting text: Responses with `incomplete/failed/cancelled`, Chat with `length`, and Anthropic with `max_tokens` cannot count as successful, even if their text is valid JSON. Python retains bounded recovery only for originally empty text whose output budget was spent on hidden reasoning; rejected nonempty text does not qualify.

Node's `analyzeBatch` stops claiming new papers after a run-level authentication or account-pool failure. Started papers still save their results; unstarted papers remain pending. The batch reports the error after its final save. A paper-level failure affects that paper's attempt. Python page review submits its thread tasks before collecting results, so it does not have the same stop-dispatch behavior.

API Reader writes from the sealed source, structured evidence, verified resources, and figures prepared for the current request. It does not use scored analysis prose as its factual source. The older 13-section analysis remains a parsing format; running Reader after scoring does not make scoring a writing input.

Each Reader protocol checks a separate object:

| Protocol | Scope |
|---|---|
| `beginner-researcher-v3` | Article structure and length |
| `api-reader-source-bindings-v4` | Each table cell maps to an original cell or exact quote; display formulas come from structured original TeX |
| `api-reader-author-identity-v1` | Authors and affiliations map to HTML, paper metadata, or an explicit unavailable state |
| `api-reader-resource-identity-v1` | Source/demo evidence, redirect destinations, and resource availability |

Structured evidence uses stable key-order hashes. Older structured files require checks of the source manifest, original text SHA, parser version, and layout. Restricted v1 sources without layout include `fresh_arxiv_text_without_layout`, `direct_conference_pdf_text`, and `conference_pdf_weak_text` with `weak-text-only-v1` capability. Their tables, formulas, and figures arrays must all be empty. Recognized older key ordering remains bound by the source manifest and original text SHA; its saved `payloadSha256` need not equal a hash recomputed in current stable key order. The program computes a stable fingerprint only in memory, without rewriting sealed files. This exception cannot carry invented structures.

Stage reuse also depends on implementation SHA. Reader checks currently include the whole `deep-analyzer.js` file, so even an unrelated change there may require another Reader run. Unchanged scoring alone does not establish Reader reuse.

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

Review never edits reviewed pages. Fixes return to analysis or generation. Push accepts only the receipt's exact additions, modifications, and deletions; baseline drift, extra staged files, hook changes, timeouts, or remote identity changes block it.

Passed page reviews are reused permanently by relative path and content SHA. Only a changed page content SHA requires another page review. Publisher changes still rerender pages to detect actual byte changes. Manifest, model, code, protocol, or Hugo changes require current batch checks and a new receipt, without re-reviewing unchanged pages. This differs from analysis-stage implementation fingerprints.

The remote OID proves that the Git commit reached the remote. Completion also requires manual verification of successful build/deploy for that publication commit, or a later commit preserving the reviewed bytes. Check HTTP 200, the official address, and the title of every target digest and paper page, and retain the results. `digest:status` does not yet perform these deployment or page checks.

## Runtime ownership

| Location | Contents |
|---|---|
| `data/current/` | Active batch state and resumable checkpoints |
| `data/archive/<date>/` | Closed-date snapshots and final visual assets |
| `data/runtime/daily-fresh-source-runs/` | Official text, PDF, runtime record, and manifest for daily analysis and publication |
| `data/runtime/fetched-arxiv-sources/` | Newly captured source-file sets for historical arXiv rewriting |
| Hugo repository | Generated pages, static assets, and verified publication commits |
| `logs/` | Redacted diagnostics under age and capacity retention rules |

File existence is not completion. Consumers check dates, paper sets, state, input fingerprints, and SHA. Historical snapshots must pass cross-file checks before recovery; they cannot conceal a current failure.

## Lock boundaries

- The full-fetch lock protects archiving, acquisition, filtering, and batch initialization.
- The normalized arXiv-ID lock protects each paper's checkpoints and merge into accepted analysis.
- JSON locks protect shared read-modify-write operations and generation counters.
- The account-pool lock protects selection and cooldown state across dates. It is held briefly for account selection or confirmed quota transitions, never during HTTP.
- The blog repository/date locks protect generation, review, Git index, commit, and push.

Inspect owner PID, hostname, heartbeat, and child processes when waiting. Only the implementation's owner and lease checks may classify a lock as stale. A slow command is not permission to remove its lock.

## Network boundary

Muse, arXiv, HuggingFace, and paper assets follow their respective project proxy rules. Other LLM providers do not automatically inherit the proxy. External assets are HTTPS-only: redirects reject private/reserved destinations, pin a validated public IP, and retain the original Host and TLS SNI. Shared LLM requests and primary analysis have their configured byte and elapsed-time checks; this does not establish identical limits for every optional script.

OpenCode Go switches accounts only for explicit HTTP 429 `GoUsageLimitError` or an exact HTTP 401 `Insufficient balance` response on the same route. Ordinary authentication 401 stops the run; generic 429, 5xx, and network failures do not switch accounts. A successful account stays selected, and an older account leaving cooldown does not trigger a switch back. Before attaching credentials, the request verifies its URL exactly matches the route derived from endpoint/model. Different services cannot share the primary account pool.

Analysis SHA checks byte identity; source checks establish that a table, formula, or claim comes from the paper. Publication additionally checks pages, receipts, Git commits, and remote state. A historical page can remain readable without qualifying for a new publication.

Historical `direct-local-first` separately captures sources and produces private analysis and pages, then reviews and publishes through `history:direct-publication`. Each arXiv generation captures new official text/PDF; conference entries revalidate retained metadata/PDF. The fallback `history:arxiv-batch` accepts only named immutable acquisition-failure handoffs. `history:crosswalk` still supports explicit older-state maintenance with source-authorization and CAS checks; normal direct work does not depend on it. The older `history:publication` still produces private files and has no equivalent publish stage.

A visual failure does not revoke a verified blog publication. Full completion still requires data, review, remote, deployment, and page checks, plus recorded visuals or a valid explicit user waiver limited to visuals.
