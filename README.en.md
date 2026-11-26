<p align="center">
  <img src="docs/images/hero-workbench.en.svg" alt="Audio Research Workbench · Overview Banner" width="100%" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong> ·
  <a href="https://nanless.github.io/audio-research-portal/">🌐 Audio Research Portal (Live)</a> ·
  <a href="https://github.com/nanless/audio-research-workbench/releases">📦 Download Mac / Android Apps</a> ·
  <a href="docs/README.en.md">📚 Documentation Index</a>
</p>

<p align="center">
  <a href="https://nanless.github.io/audio-research-portal/"><img src="https://img.shields.io/badge/Live_Portal-Audio_Research_Portal-0f766e?style=flat-square" alt="Audio Research Portal" /></a>
  <a href="https://github.com/nanless/audio-research-workbench/releases"><img src="https://img.shields.io/badge/Client-v1.5.0_(Build_24)-1d4ed8?style=flat-square" alt="Client v1.5.0" /></a>
  <img src="https://img.shields.io/badge/macOS-15%2B_Apple_Silicon-334155?style=flat-square" alt="macOS 15+" />
  <img src="https://img.shields.io/badge/Android-9%2B_(4_ABIs)-334155?style=flat-square" alt="Android 9+" />
  <img src="https://img.shields.io/badge/Archive-9%2C300%2B_Verified_Papers-4338ca?style=flat-square" alt="9,300+ Verified Papers" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-15803d?style=flat-square" alt="MIT License" /></a>
</p>

Dozens of new speech, music, acoustics, and Audio LLM papers land on arXiv and top venues every week—skimming abstracts hides critical trade-offs, while reading every full PDF eats your entire morning.

**Audio Research Workbench (`音频研究工作台`)** turns that grind into an **end-to-end, source-verified research system**:

- **Content Production Engine (this repo)**: Fetches and deduplicates papers via an LLM/API pipeline by default, seals each paper's official HTML and PDF into a SHA-256 bundle, produces deep analyses, eight-dimension scores, nine-facet classifications, and long-form Chinese guides (**Reader** in code), and publishes only after a strict three-layer review gate.
- **Public Knowledge Site ([Audio Research Portal / 音频研究门户](https://nanless.github.io/audio-research-portal/))**: Hosts **9,300+ verified Chinese paper guides**, daily digests, top-conference collections, and 8 domain SOTA hubs with instant search, zoomable figure viewers, sortable tables, and one-click BibTeX / RIS citations.
- **Native Desktop & Mobile Clients (macOS & Android)**: Sync published snapshots read-only for quiet offline reading, side-by-side PDF comparison, native daily audio podcasts, structured notes, opt-in personal LLM study, Zotero archiving, and versioned WebDAV sync.

> **Language note**: Published articles and portal pages are written in Chinese. This README guides English-speaking readers and maintainers through the architecture, clients, and CLI workflows; linked operational guides are in Chinese unless marked otherwise.

---

## ✨ Inside the Live Audio Research Portal

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://nanless.github.io/audio-research-portal/">
        <img src="docs/images/portal-home-preview.png" alt="Audio Research Portal home view showing latest daily edition, search, and conference hubs" width="100%" />
      </a>
      <p align="center"><sub><strong>Audio Research Portal Home</strong> · Daily highlights, instant search, 9-facet taxonomy &amp; venue collections</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://nanless.github.io/audio-research-portal/">
        <img src="docs/images/portal-paper-preview.png" alt="Audio Research Portal paper page showing quick audio spec card, 8-dimension score, math, and figures" width="100%" />
      </a>
      <p align="center"><sub><strong>Deep-Dive Paper Page</strong> · Audio spec card, type-aware 8-dim score, KaTeX math &amp; verified paper figures</sub></p>
    </td>
  </tr>
</table>

### What makes this different from generic AI paper summaries?

| Common Failure Mode | How Audio Research Workbench Handles It |
|---|---|
| Jargon-heavy summaries that skip how a method works | Every public **Reader** guide spans **5,000–18,000 Chinese characters** across 5–9 problem/mechanism/finding sections with structured implementation specs and optional concept bridges—stored separately from the 13-section internal audit analysis. |
| Hallucinated metrics, broken equations, mismatched figures | Before writing starts, official HTML and PDF bytes are sealed into a 4-file SHA-256 bundle; table cells are verified back against original tables, displayed equations use source TeX, and original paper figures pass visual & factual checks. |
| Dead "open-source" links and inflated 9/10 scores | Code, weights, and demo URLs are checked for live availability (only verified `available` links may be claimed open-source); scores use **type-aware 8-dimension rubrics (`type-aware-v2`)** recomputed in code. |
| Silent publish regressions or broken live pages | Every batch runs `generate → 3-layer review → receipt-bound push → GitHub Pages deploy check → live HTTP 200 & title verification`. Any failure blocks release. |

---

## 🎯 Start Where You Need (30 Seconds)

| What you want to do | Where to go |
|---|---|
| 🌐 Read 9,300+ verified guides in your browser | Open the **[Audio Research Portal](https://nanless.github.io/audio-research-portal/)** · citations & downloads in [reading tools](docs/blog-reading-tools.md) (Chinese) |
| 💻 Read side-by-side with PDFs & archive to Zotero on Mac | Follow the **[Mac Guide](apps/macos/README.en.md)** (Apple silicon, macOS 15+, zero `.env` setup) |
| 📱 Read offline & listen to daily podcasts on Android | Follow the **[Android Guide](apps/android/README.en.md)** (Android 9+, all 4 ABIs) |
| 🗺️ Understand how all subsystems fit together | Read the **[Project Walkthrough](docs/project-guide.md)** (Chinese) |
| 🛠️ Run daily digests, conference sweeps, or historical updates | Complete **[First-time setup](#first-time-setup-maintainers)** below and follow the **[Operating Manual](SKILL.md)** |

---

## 🏗️ Three-Layer Architecture: Zero Model Cost When Reading

![Audio Research Workbench three-layer architecture: content engine, Audio Research Portal, and native Mac & Android apps](docs/images/workbench-architecture.en.svg)

Production, publishing, and personal reading stay strictly isolated:

1. **Content Production Engine (this repo)**: Drives three independent pipelines—**daily digests**, **official conferences**, and **historical blog updates**—each with isolated source sealing, deduplication baselines, and review receipts.
2. **Audio Research Portal (Hugo static site)**: Serves the public web archive, 400-concept 9-facet taxonomy, 8 SOTA domain hubs, Pagefind search, and content-addressed client snapshots (`client/details/*`) while retaining legacy `/audio-paper-digest-blog/` path compatibility.
3. **Native Mac & Android Workbench Apps**: Fetch published snapshots and podcast releases read-only. Opening papers never calls a production LLM; personal study is strictly opt-in using your own model endpoint on confirmed extracted text only.

---

## 📱 Native Mac & Android Workbench (v1.5.0)

![Mac and Android Workbench reading, podcast, and personal sync boundaries](docs/images/client-experience.en.svg)

| Capability | 🌐 Audio Research Portal | 💻 macOS Workbench | 📱 Android Workbench |
|---|:---:|:---:|:---:|
| 9,300+ guides, 400-concept taxonomy & score filters | ✅ Instant web browse | ✅ Offline snapshots & index | ✅ Offline snapshots & preload |
| Guide + side-by-side PDF with physical page anchors | 🔗 Source links | ✅ Native AppKit + PDFKit | ✅ Phone 1-col / Tablet 2-col |
| Native Daily Audio Podcast (chapters, 0.75×–2.0×) | ✅ Web player | ✅ SHA-verified local cache | ✅ SHA-verified local cache |
| Sanitized HTML5, MathML & inline SVG rendering | ✅ Hugo KaTeX SSR | ✅ Strict allowlist sanitizer | ✅ Strict allowlist sanitizer |
| Personal LLM Q&A (user endpoint, isolated billing) | — | ✅ Confirmed text only | ✅ Confirmed text only |
| Zotero Archiving (metadata + guide + PDF + notes) | 📥 BibTeX / RIS | ✅ Local Zotero Desktop API | ✅ Official Zotero Web API v3 |
| Versioned WebDAV Sync & lossless note conflict merge | — | ✅ Secrets stay on device | ✅ Secrets stay on device |

- **Current source version**: **1.5.0 (build 24)** on both macOS and Android (adds the native daily podcast player, aligned offline search/filtering, full rename to `音频研究工作台` / Audio Research Workbench, and legacy `/audio-paper-digest-blog/` compatibility; see the [1.5.0 record](docs/workbench-1.5.0-review.md)).
- **Latest public release**: **1.4.7 / build 23** (published 23 Nov 2026; see [GitHub Release v1.4.7](https://github.com/nanless/audio-research-workbench/releases/tag/v1.4.7) and [client release verification](docs/client-release-verification.md)). Earlier versions live in [docs/README.en.md](docs/README.en.md).
- **Upgrade notes**: Upgrading from 1.4.x to 1.5.0 renames the macOS app bundle to `音频研究工作台.app` while preserving `com.nanless.PaperDigest`, existing data directories, and Keychain entries—quit and remove the old bundle after installing. macOS builds use local ad-hoc signing (not Apple-notarized, macOS 15+ Apple silicon). Android keeps `com.nanless.paperdigest` and the 1.4.4+ signing certificate so 1.4.4+ upgrades in place (1.4.3 requires backing up and uninstalling first).

---

## ⚙️ How a Paper Moves From arXiv to a Verified Live Page

![Daily digest end-to-end pipeline: boundary fetch, screening, four-file sealing, analysis, three-layer review, and live web checks](docs/images/daily-digest-flow.en.svg)

Content production uses an **LLM/API pipeline by default** across three isolated workflows:

| Workflow | Purpose | Source & Dedup Boundary | Guide |
|---|---|---|---|
| **Daily digest** | Track daily arXiv & HuggingFace audio preprints | Sync portal remote, dedup published pages only, re-fetch & seal official HTML + PDF | [Daily procedure](SKILL.md#1-日更) · [Fetch boundary](docs/daily-fetch-boundary.md) |
| **Official conference** | Process ICML / Interspeech / ICASSP proceedings | Bind official conference metadata & verified PDFs independently | [Conference workflow](docs/conference-workflow.md) |
| **Historical update** | Rewrite older posts from original papers keeping URLs | Lock explicit page scope and publish through dedicated receipts | [Historical updates](docs/history-rewrite.md) · [Publication](docs/history-direct-publication.md) |

**Four engineering safeguards keep quality verifiable and cost bounded:**

1. **Four-file source sealing**: Before analysis begins, each paper's `source.txt`, `source.pdf`, `source-runtime.json`, and `source-manifest.json` are hashed and frozen; writing, local repairs, and pre-publish audits all read the exact same bundle.
2. **Tiered per-stage reasoning + prefix caching**: Enabled by default (`PD_TIERED_REASONING_EFFORT`) with stage-stable `prompt_cache_key`—`xhigh` for primary analysis & Reader articles, `high` for scoring audits & repairs, `medium` for figure/table patches, `low` for screening & text review, and `minimal` for mechanical tagging/OSS checks.
3. **Equal-weight API account pool & immutable ledger**: Keys route stably by `paperId` affinity to maximize cache hits; only quota 429 or insufficient-balance 401 rotates within a request, while auth 401 halts dispatch to protect in-flight work. Usage records shard by Beijing date and are never wiped.
4. **Three-layer review gate & permanent SHA cache**: Programmatic checks, text/figure review, and full Hugo builds gate every push; approved pages cache permanently by relative path and content SHA.

---

## First-time setup (maintainers)

> Skip this section completely if you only read the portal or use the Mac / Android apps—no repository clone or API key is needed.

1. **Verify workspace & role**: Enter `$HOME/code/github_repos/audio-research-workbench`, check `pwd`, and run `npm run workspace:role -- status` to confirm role `daily` (historical commands run here via `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` in `.env`).
2. **Install runtimes & `.env`**: Follow [setup](docs/setup.md) (Chinese) for Node (`>=20.18.1 <21 || >=22.3.0`), Python 3.11+ (`scripts/python-runtime.sh` prefers `.venv`), and dependencies; copy `env.example` to `.env` with API keys, HTTP CONNECT proxy, and your local Hugo portal repo path.
3. **Run read-only diagnostics**: Run `npm run doctor -- --offline` and `npm run config:check`. Both primary and any enabled secondary model use `muse-spark-1.3-contributor` (`xhigh` ceiling); arXiv and Muse traffic require the project HTTP CONNECT proxy.
4. **Ensure clean concurrency**: Confirm no other generate/review/push task is active and the portal repo has no conflicting uncommitted edits for the target date.

Authoritative hard rules live in [AGENTS.md](AGENTS.md), with step-by-step walkthroughs in [onboarding](docs/onboarding.md) and the [operating manual](SKILL.md).

---

## Common maintenance commands

Replace example dates, IDs, and paths with real parameters before running:

| Task | Command & guide |
|---|---|
| **Run today's daily digest** | `npm run digest:prepare -- YYYY-MM-DD` (`digest:api` alias); [daily procedure](SKILL.md#1-日更) |
| **Diagnostics & source probes** | `npm run doctor -- --offline` (`--network` probes arXiv), `npm run config:check`, `npm run source:probe -- --date YYYY-MM-DD`, `npm run llm:accounts` |
| **Live progress & stage scorecard** | `npm run digest:status -- --date YYYY-MM-DD --watch`, `npm run digest:scorecard -- --date YYYY-MM-DD` |
| **Official conference sweep** | `conference:acquire` → `conference:discover` → filter → `conference:process`; [conference workflow](docs/conference-workflow.md) |
| **Rewrite historical pages** | Lock scope, then `history:inputs` / `plan` / `sources` / `run` / `aggregate`; [historical updates](docs/history-rewrite.md) |
| **Publish historical output** | `npm run history:publication -- plan\|generate\|review\|publish\|status`; [historical publication](docs/history-direct-publication.md) |
| **Republish a daily batch presentation** | `npm run blog:generate -- --date YYYY-MM-DD --republish UUID`, then `blog:review` → `blog:push` |
| **Diagnose failures & build patch specs** | `npm run recover -- --date YYYY-MM-DD`, `npm run manifest:new -- --spec SPEC.json` |
| **Register earlier fetch witness** | `npm run fetch:witness:prepare -- --date YYYY-MM-DD --source-date YYYY-MM-DD` |
| **Table precheck, impact & overrides** | `npm run table:check -- --draft FILE`, `npm run impact -- --git`, `npm run review:overrides -- --date DATE --file F.json` |
| **Live site verification & closeout** | `npm run verify:web -- --date DATE --deploy OID`, `npm run publish:finish -- --date DATE` |
| **Locks, docs & data integrity** | `npm run locks`, `npm run docs:check`, `npm run validate:data` |
| **Ledger compaction & PDF dedupe** | `npm run papers:compact`, `npm run storage:pdf-dedupe`, `npm run storage:report`, `npm run storage:prune` |
| **Opt-in CLIs: calibration / podcast** | `npm run digest:calibrate -- --dry-run`, `npm run podcast:generate -- --date YYYY-MM-DD --dry-run` |
| **Full local verification suite** | `npm run verify` (pinned Hugo 0.160.1 + syntax + JS/Python suites + data validation) |

---

## Running a daily digest

Use **today's Beijing date**:

```bash
npm run digest:prepare -- YYYY-MM-DD
```

This runs the complete pipeline: portal remote sync → boundary fetch & published-page dedup → prefilter & LLM triage → four-file HTML/PDF sealing → full analysis, scoring, tagging & Reader writing → page generation & three-layer review → receipt-bound push & no-visuals attestation. After push, confirm GitHub Pages deployment and verify every live URL, HTTP 200 status, and title.

**Three hard boundaries:**

- **No daily posters or covers**: Following the standing 2026-11-02 directive, daily runs skip generated posters/covers (`--no-visuals` kept for compatibility) and record a bound no-visuals attestation; original paper figures remain fetched, displayed, and reviewed.
- **Today only for fresh fetch**: Historical dates cannot restart daily fetching; resume from controlled data via `--from generate|review|push|visual` or use the historical rewrite workflow ([fetch boundaries](docs/daily-fetch-boundary.md)).
- **Published-only deduplication**: Unpublished papers in the local library remain eligible for future catch-up runs.

---

## Continuing after a failure

Always let the active round finish and save every paper before retrying only eligible failures. Passing sources, checkpoints, drafts, attempt counts, and cost ledgers are preserved intact and never wiped.

| Where work stopped | How to resume |
|---|---|
| Daily analysis or Reader writing | `npm run deep`, `npm run batch`, or `npm run api:reader:refresh` (reuses the same sealed bundle) |
| Official conference run or maintenance | Resume `conference:process` / `conference:migrate-process`; see [conference recovery](docs/conference-workflow.md#已有完整会议只更新页面) |
| Historical prep or analysis | Continue the same plan with `npm run history:run`; resume paused jobs with `npm run history:resume` |
| Blog text or figure rejection | Complete the review batch first; text goes through Reader maintenance, figures can use a certified PDF publication view before re-review |
| Auth, balance, config, or save error | Halt new dispatches, preserve in-flight work, diagnose the full account pool or fault, then resume |

For a small stubborn tail after automatic retries, apply source-bound operator corrections (1–8 existing nodes per paper, still checked by full qualification and blog review; see [explanation recovery](docs/reader-explicit-retry.md)). Necessary paid follow-up windows are covered by the standing authorization in [AGENTS.md](AGENTS.md#持续授权以效率和效果为准) under separate accounting.

> **Retired legacy boundary**: Batch Manual authoring and WeChat/Feishu/Xiaohongshu publishing are retired. [manual/README.en.md](manual/README.en.md) retains only legacy record verification and independent manual review (configured with `gpt-6.1-sol/high`).

---

## What counts as done

A daily digest is complete only when all six criteria in [AGENTS.md](AGENTS.md#日更完成的六项) hold:

1. **Data & sources**: Formal analysis, sealed sources, Reader guide, 8-dim score, and 9-facet tags pass all checks.
2. **Review**: Pages pass programmatic, text, figure, and Hugo checks with receipts covering the full target set.
3. **Remote push**: Only the receipt-approved diff is pushed and remote `main` OID matches.
4. **Deployment**: GitHub Pages `build` and `deploy` both succeed for the published commit (or a descendant preserving reviewed bytes).
5. **Live web check**: Every target page passes HTTP 200, canonical URL, and title checks (`npm run verify:web`) with saved proof.
6. **No-visuals & final status**: A bound no-visuals record is valid and `npm run digest:status -- --date YYYY-MM-DD` is re-read.

`digest:status` is a snapshot at read time and never substitutes for live deployment and page verification.

---

## 📁 Repository Map

```text
audio-research-workbench/
├── scripts/               # Production engine (fetch, filter, seal, analyze, score, Reader, review, push, podcast)
│   └── lib/               # Shared libs: LLM router/cache/pool, source checks, SVG/PDF pipeline, locks & ledgers
├── prompts/current/       # Active stage prompt templates (with Git blob cold-replay evidence index)
├── config/                # 400-concept 9-facet taxonomy, protocol registries (clients*.json), workspace roles
├── apps/
│   ├── macos/             # Native macOS Audio Research Workbench (Swift / AppKit / WebKit / PDFKit)
│   └── android/           # Native Android Audio Research Workbench (Kotlin / Jetpack Compose / Room)
├── docs/                  # Architecture, data contracts, playbooks, acceptance matrices & diagrams (docs/images/)
├── skills/                # Reusable clear-technical-writing and engineering skills
├── manual/                # Read-only legacy verification & independent single-paper manual review
└── tests/                 # Node.js + Python regression suites (offline contracts & cold-replay tests)
```

---

## Documentation

- 🗺️ **[Project walkthrough](docs/project-guide.md)** (Chinese): sources, analysis engine, portal, and clients at a glance.
- 📖 **[Operating manual](SKILL.md)** & **[AGENTS.md](AGENTS.md)** (Chinese): procedures, recovery paths, and hard rules.
- 📚 **[Documentation index](docs/README.en.md)**: setup, data contracts, taxonomy, backups, performance, and troubleshooting.
- 🔧 **[Script guide](scripts/README.en.md)** & **[full script index](scripts/INDEX.md)**: CLI entry points, shared core, and helpers.
- 🔐 **[Client release verification](docs/client-release-verification.md)** (Chinese): macOS/Android signing, certificates, 12 assets, and SHA-256 records.
- ✍️ **[Clear technical writing](skills/clear-technical-writing/SKILL.md)** & **[project writing guide](docs/writing-guide.md)** (Chinese): clarity, terminology, diagrams, and bilingual rules.
