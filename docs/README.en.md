# Documentation

[中文](README.md) · **English**

These guides cover the Audio Paper Digest website, its content workflows, and the Mac and Android reading applications. Choose the task first, then read the relevant details. You do not need to read every protocol before starting. Actual commands and execution constraints are defined by the implementation and [AGENTS.md](../AGENTS.md).

Unless an English README is explicitly linked below, the detailed documents are in Chinese. This index does not imply that the detailed guides or the published articles have English editions.

## New to the project

The [project walkthrough](project-guide.md) explains sources, analysis, explanations, publication, and reading applications. The [project README](../README.en.md) helps you choose a task. [Onboarding](onboarding.md) covers the prerequisites, execution, results, and failure routes for a daily digest.

To read published content, use the [website](https://nanless.github.io/audio-paper-digest-blog/) or install the [Mac](../apps/macos/README.en.md) or [Android](../apps/android/README.en.md) application. The production project's `.env` is not required. Daily, official-conference, and historical-update work are three production workflows that call a language model service through an API by default. Reading existing content or restoring personal data does not start those workflows.

See the [terminology guide](writing-guide.md#术语先解释再统一称呼) for unfamiliar terms. When editing, use [clear technical writing](../skills/clear-technical-writing/SKILL.md) together with the [project writing rules](writing-guide.md), preserving actual conditions, evidence, and execution scope.

## Read papers and use the applications

| Goal | Guide |
|---|---|
| Download papers, explanations, and citations | [Website reading resources](blog-reading-tools.md) |
| Install and use the Mac application | [Mac guide](../apps/macos/README.en.md) |
| Install and use the Android application | [Android guide](../apps/android/README.en.md) |
| Understand favorites, website classifications, and date groups | [Favorites](favorite-collections.md) |
| Compare platform features and window adaptation | [Android feature mapping](android-feature-parity.md), [interface design](macos-interface-design-research.md) |
| Understand personal study and product decisions | [Workbench design](desktop-research-workbench-plan.md), which separates current capabilities from future goals |

The [1.3.0 record](workbench-1.3.0-review.md) covers classification browsing, both interfaces, final packages, upgrades, and public downloads. Other versions retain their own dates, environments, and tested scope. They do not establish that every real-service operation was repeated on the current package.

### Implementation, backups, and archiving

| Topic | Guide |
|---|---|
| Mac feature requirements | [Requirements](mac-app-requirements.md) |
| Mac website data and personal model records | [Data and recovery](mac-app-data.md) |
| Mac Zotero connection, archiving, and resumption | [Zotero integration](mac-app-zotero.md) |
| Mac cloud backup versions and restoration | [Cloud data and backups](mac-app-cloud.md) |
| Mac testing and acceptance status | [Validation](mac-app-validation.md), [acceptance matrix](mac-app-acceptance.md), [current status](mac-app-acceptance-status.md), [review procedure](mac-app-review-log.md) |
| Mac release packages and icons | [Release preparation](mac-app-release.md), [icon design](mac-app-icon-design.md), [source assets](../apps/macos/Assets/README.en.md) |
| Android product and implementation scope | [Application design](android-app-plan.md) |
| Android Zotero and full backups | [Zotero integration](android-zotero-research.md), [backup contract](android-cloud-contract.md) |
| Cross-platform backup format and actual validation | [Portable fixtures](android-cloud-portable-fixtures.md), [Android validation](android-validation.md) |
| Client security and licensing | [Security record](client-security-audit.md), [Android license inventory](../apps/android/licenses.README.en.md) |
| Proposed static data interface | [desktop/v1 contract](desktop-data-contract.md); this optional interface is not deployed |
| Browser prototype | [Prototype guide](../prototypes/macos-research/README.en.md); its scope is separate from the released applications |

## Run a production task

First prepare the environment using [setup](setup.md), then follow the [operating manual](../SKILL.md). The [shared workflow guide](three-workflows.md) explains common code and distinct sources. [Workflow maintenance](workflow-sharing-plan.md) explains responsibilities and design decisions.

| Task | Instructions |
|---|---|
| Today's digest or recovery from a saved stage | [Daily procedure](../SKILL.md#1-日更), [fetch boundaries](daily-fetch-boundary.md), [source checks under locks](locked-source-validation.md) |
| Official conference acquisition, filtering, analysis, and publication | [Conference workflow](conference-workflow.md) |
| Rewrite historical pages from original papers while retaining URLs | [Historical sources and updates](history-rewrite.md) |
| Review, publish, and verify completed historical work | [Historical publication](history-direct-publication.md) |
| Update only the presentation of a complete daily batch | [Republication with unchanged sources and analysis](data-format.md#同来源同分析的日批重发布) |

## Handle failures and older records

Preserve failures, sources, stage results, and costs. Finish the current round before retrying only the eligible failures. Increasing outer batch rounds does not automatically increase the explanation-writing request allowance.

| Problem | Instructions |
|---|---|
| Batch rounds or a suggestion for manual intervention | [Shared batch rules](three-workflows.md#全批轮次与失败集合) |
| Stop a running analysis | [Stopping](analysis-stop.md) |
| Identify the cause and continuation route from an error | [Troubleshooting](troubleshooting.md) |
| Usage records cannot be saved | [Start, terminal, and exceptional-response records](data-format.md#请求开始终态与异常响应保全) |
| Revalidate a paid explanation, register a new window, or apply a controlled correction | [Explanation recovery](reader-explicit-retry.md) |
| A conference recovery window is exhausted | [Subsequent windows](conference-workflow.md#原额度耗尽后的独立付费恢复), [record format](data-format.md#会议独立追加窗口) |
| Conference blog text or figures are rejected | [Normal explanation maintenance](conference-workflow.md#博客拒稿后的正常-reader-维护), [maintenance records](data-format.md#会议博客审查后的-reader-维护记录) |
| Conference postprocessing or zero-request source-based corrections | [Source corrections](conference-workflow.md#认证来源事实的零请求纠正); resource and core-summary manifests are checked separately |
| Old data, protocols, or original prompt bytes | [Compatibility](compatibility.md), [legacy verification and independent review](../manual/README.en.md) |

Standing paid authorization permits necessary subsequent windows, with original sources, attempt counts, and costs retained. Old source checks, read-only replay, and historical reviews do not independently authorize new model requests or publication.

## Change code, edit prose, or inspect protocols

| Topic | Guide |
|---|---|
| Current commands, entry points, and shared modules | [Script index](../scripts/README.en.md), [workflow map](three-workflows.md) |
| Changes, validation, Chinese commits, and pushing | [Maintenance](maintenance.md) |
| The 18 current prompts and original historical bytes | [Prompt index](../prompts/README.en.md), [prompt changes](maintenance.md#prompt-修改) |
| Explanation structure and source requirements | [Reader writing](reader-writing.md) |
| Explanations, paragraphs, figures, and bilingual maintenance | [Writing rules](writing-guide.md), [writing skill](../skills/clear-technical-writing/SKILL.md) |
| Fields, manifests, and publication receipts | [Data format](data-format.md) |
| Hierarchical classifications, old signatures, and site-catalog synchronization | [Shared classification rules](tag-display-policy.md#三条流程共用的目录与呈现) |
| Classification-vocabulary design | [Tag design](tag-system-design.md) |
| Timing measurements and optimization scope | [Performance](daily-performance.md) |
| Compatibility retention and documentation maintenance | [Maintenance principles](repository-maintenance-review.md) |

## Read historical review records

These records explain the problems, changes, and actual verification at the time. They are not separate current operating procedures.

- Workbench versions: [1.1.0](workbench-1.1.0-review.md), [1.2.1](workbench-1.2.1-review.md), [1.3.0](workbench-1.3.0-review.md).
- Workbench usability: [2026-11-01 review](workbench-usability-review-20261101.md).
- Shared workflows and maintenance: [workflow review](shared-workflow-review.md), [repository maintenance](repository-maintenance-review.md).
- Documentation and prompts: [2026-11-02 full-scope review](documentation-review-20261102.md).
- Beginner explanations, complete bilingual guides, and diagrams: [2026-11-03 revision and review](documentation-rewrite-20261103.md).

## Establish completion

A production task requires deployment and all target pages to be verified against the actual publication. Status reporting, a Git push, and a live web page are separate results.

Daily work follows the standing instruction not to generate images. A valid waiver is bound to the current publication; original paper figures still undergo source and image review. Generate new images only if the user separately and explicitly changes the requirement for that batch.
