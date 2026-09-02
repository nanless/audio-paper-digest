# Default LLM/API architecture

This page explains component ownership, the per-paper state machine, publication transactions, and runtime data boundaries. Use [Scripts](scripts.md) for commands, [Data formats](data-format.md) for persisted fields, and the [Manual subsystem](../../manual/README.md) only for explicitly requested Manual runs.

## Components

```text
run-daily-digest.sh
  ├─ full-fetch.js
  │    ├─ arXiv / HuggingFace acquisition and LLM filtering
  │    └─ analysis-engine.js → deep-analyzer.js
  ├─ generate-blog.py
  ├─ review-blog.py → deterministic, LLM, image, and Hugo gates
  ├─ push-blog.py → exact Git delta and remote OID verification
  └─ visual planners → Codex image_gen → record/status
```

Node owns acquisition, filtering, analysis checkpoints, canonical results, and visual manifests. Python owns page generation, immutable review artifacts, Hugo validation, and the Git publication transaction. The Hugo repository is a publication target, never a source of analysis facts.

## Per-paper analysis DAG

```text
source acquisition
  → primary analysis
  → project/demo evidence
  → revision and structural repairs
  → scoring audit and stability resolution
  → API Reader article and official Figures
  → optional legacy image supplement
```

Every stage binds its inputs, model and protocol, prompt, evidence budget, output hash, and terminal state. A changed input invalidates that stage and its downstream consumers, not unrelated papers.

Model output is bounded independently by tokens, an absolute deadline, and total response bytes. Responses `incomplete`, Chat `length`, Anthropic `max_tokens`, a missing SSE terminal event, or a byte-limit breach fails before article parsing, so partial JSON cannot become a successful stage.

Reader contracts are orthogonal. `beginner-researcher-v3` governs tutorial structure; `api-reader-source-bindings-v4` replays every table cell to an original DOM cell or exact source quote and injects display formulas from structured source TeX. `api-reader-author-identity-v1` binds every displayed author and affiliation to HTML, paper metadata, or an explicit unavailable state. `api-reader-resource-identity-v1` binds project links to exact paper/demo evidence, redirect outcomes, and availability. Official Figures are materialized first and then bound to the final article and plan.

## Publication transaction

```text
canonical batch
  → generation manifest v3 and exact page bytes
  → immutable per-page review artifacts
  → deterministic / LLM / image review
  → isolated Hugo gate
  → receipt bound to page hashes and Git baseline
  → exact commit → push → live remote-main OID verification
  → post-publication visual manifests
```

Review never edits a reviewed page. Fixes return to analysis or generation and produce new bytes. Push accepts only the exact delta in the receipt; baseline drift, extra staged files, hook mutations, timeouts, or remote identity changes fail closed. A verified publication remains valid if later visual generation fails, but the daily business state remains incomplete until visuals are recorded or explicitly waived.

## Runtime ownership

| Location | Authority |
|---|---|
| `data/current/` | active batch state and resumable checkpoints |
| `data/archive/<date>/` | closed-date snapshots and final visual assets |
| Hugo repository | generated pages and verified publication commits |
| `logs/` | redacted diagnostics under age and capacity retention |

File existence alone is not completion. Consumers revalidate dates, paper sets, source identities, hashes, and contract versions. Historical artifacts may remain readable without qualifying for a new production generation.

## Lock boundaries

- The full-fetch lock protects archive, acquisition, filtering, and batch initialization.
- A normalized arXiv-ID lock protects each paper's checkpoints and canonical merge.
- JSON locks protect shared read-modify-write state and generation counters.
- The blog date/repository lock protects generation, review, the Git index, commit, and push.

Only the implementing lease/owner checks may classify a lock as stale. Never remove a lock merely because a command appears slow.

## Network boundary

Muse, arXiv, HuggingFace, and paper assets follow their project proxy policies; unrelated LLM providers do not inherit that proxy automatically. External assets are HTTPS-only, reject private/reserved targets on every redirect, pin the validated public IP, and preserve the original Host and TLS SNI. All network responses and subprocesses have byte and absolute-time bounds.
