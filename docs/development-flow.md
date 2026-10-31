# Development Flow

This document defines the default development flow for sandbox, with particular emphasis on AI-assisted development.

## 1. Start with an Issue

Work should begin with an Issue.

The Issue should clearly state:

- the problem
- the expected outcome
- relevant context

The Issue defines the scope of the work. If the scope is unclear, clarify the Issue before implementation instead of inventing requirements during the change.

By default, completion criteria should be executable and verifiable by an AI agent. Require human checks, such as physical-device testing, subjective evaluation, or external approval, only when there is a necessary reason to do so.

When human work is required, state why it is necessary and what result is expected. Distinguish optional additional validation from mandatory completion criteria.

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Record required checks possible only after merge separately as post-merge verification. These checks must not be prerequisites for pre-merge Pull Request approval. This distinction does not remove implementation requirements or applicable pre-merge tests.

For example, when deployment is triggered by merge, validate the code/configuration, local build, and applicable automated tests before merge. Check deployment success and verify the newly published site after merge. Report those post-merge checks as pending until performed, then record their actual results.

Use the [Issue template](../.github/ISSUE_TEMPLATE/issue.md) to separate the two kinds of criteria.

## 2. Create a Pull Request for the Issue

Implementation should be proposed through a Pull Request associated with the Issue.

The Pull Request should explain:

- what changed
- what outcome the change produces
- how the change was validated
- required post-merge verification, reported separately as pending until performed
- which Issue it addresses

A Pull Request should only claim to close an Issue when it fully addresses that Issue.

If the Pull Request intentionally implements only part of the Issue, it should state that clearly and should not present the Issue as fully resolved.

Choose and report validation using the [test and CI performance principles](#test-and-ci-performance-principles).

## 3. Review Before Merge

Every Pull Request should be reviewed before merge.

A central review question is:

> Does this Pull Request address the Issue completely, without adding changes that are not justified by the Issue?

Review must check both directions:

- **No missing scope:** the Pull Request should not leave required parts of the Issue unresolved while claiming completion.
- **No unnecessary scope:** the Pull Request should not introduce unrelated abstractions, frameworks, policies, or complexity beyond what is needed to solve the Issue.

This is especially important for AI-generated changes. AI agents may produce broader or more elaborate designs than the task requires. Prefer the smallest change that fully satisfies the Issue.

Apply the [review guidelines](review-guidelines.md#check-validation-timing): require complete implementation and sufficient pre-merge validation, while allowing required post-merge verification to remain pending. A pending post-merge check must not be reported as passed or treated as missing implementation.

## 4. Revise Until Review Passes

If review finds missing requirements, unnecessary scope, correctness problems, or insufficient validation, update the Pull Request and review it again.

The Pull Request should be merged only when the reviewed change is an appropriate and complete response to the Issue.

## 5. Merge

After review passes, merge the Pull Request.

## 6. Perform Required Post-Merge Verification

Perform the separately recorded post-merge checks once they are possible. For merge-triggered publication, check the deployment result and the newly published site as described in the [Pages deployment guidance](../README.md#github-pages-deployment).

Keep each check marked pending until performed, then report whether it passed or failed with the evidence. Record failures and follow-up work; pre-merge approval does not establish that post-merge verification passed.

The normal flow is therefore:

```text
Issue
  ↓
Implementation
  ↓
Pull Request
  ↓
Review
  ↓
Revision if needed
  ↓
Merge
  ↓
Required post-merge verification (if any)
```

## Test and CI Performance Principles

**Detect the required failures at the lightest appropriate layer, without redundant execution.**
Preserve required correctness, regressions, and meaningful integration coverage
when moving or consolidating checks.

1. **Prefer the lightest meaningful test layer.** Use fast Python/Node unit or
   component tests for calculations, branches, game rules, and broad data cases.
   Reserve Chromium/Playwright, Miniflare/workerd with D1 and Durable Objects,
   real WebRTC, and real-model checks for boundaries that need those environments.
   Test concrete defects rather than mirroring implementation details.
2. **Choose combinations deliberately.** Cover distinct paths with representative
   project, state, viewport, language, model, and deployment cases instead of
   multiplying every dimension. Exhaust combinations when their interactions
   matter, such as all nine rock-paper-scissors hand pairs. Retain required
   regressions and integration assertions when redistributing coverage.
3. **Match validation to the change.** Documentation-only changes need Markdown,
   link/anchor, consistency, and whitespace checks (`git diff --check`); they do
   not alone require application builds or browser suites. UI changes need
   relevant interaction, accessibility, layout, and preview checks; core/runtime
   changes need relevant rules, persistence, protocol, and failure/recovery tests.
   CI/build changes need workflow/configuration, build, and affected integration
   validation. Use focused checks for fast feedback and the applicable full
   regression suites before merge. The current [Pages workflow](../.github/workflows/pages.yml)
   runs its configured validation on PRs without change-based selection; this
   guidance does not waive those checks. Provisioning, production migrations,
   Worker deployment, and Pages publication run on `main`; required deployed-site
   checks belong in separately recorded post-merge verification. Optional extra
   validation is distinct from mandatory pre-merge checks. The livestream's
   [opt-in real-model check](../projects/ai-livestream/README.md#validation)
   remains outside ordinary CI; relevant Issue requirements still apply.
4. **Reuse work and eliminate duplicate execution.** Reuse builds, fixtures,
   downloads, and expensive setup where safe, with cache keys matching inputs
   and tool versions and isolated mutable test state. CI already uses npm caching
   keyed by the Worker lockfile. Avoid equivalent runs for the same revision
   through overlapping push/PR triggers; preserve the distinct `main` deployment
   responsibility. Cancel superseded validation when safe, preserving deployment
   ordering (the current workflow does not cancel in-progress runs). Measure
   resource use before adding parallel workers. Repeated execution can be
   necessary: applying local D1 migrations twice verifies idempotence.
5. **Review test value and added cost together.** Ask which additional defect a
   new or expanded test detects, whether existing coverage already supplies that
   confidence, and what execution and maintenance cost it adds. Watch repeated
   fresh browser/runtime/bundle setup, large fixtures or model downloads, long
   emulation/alarm waits, and Cartesian-product growth. Preserve real-alarm and
   screenshot network-isolation checks that establish distinct guarantees.
6. **Maintain an execution-time budget.** No normal-CI timing baseline or target
   is documented yet. Establish one from actual representative runs during
   test/CI performance work, then monitor growth and investigate overruns.
   Separate elapsed feedback time, total runner/computation time, and queue time.
   Revisit validation structure and duplication before sacrificing meaningful
   assertions or required coverage. Existing per-capture limits and model timing
   reports are not a normal-CI budget; this guidance adds no benchmark, hardware,
   or approval gate.

Use the [Pages workflow](../.github/workflows/pages.yml),
[site build instructions](../README.md#build-and-preview-locally), and
[Worker checks](persistent-counter.md#local-development-and-pre-merge-checks)
for current commands and setup. Changes to triggers, selection, caches, timeouts,
workers, or tests require separately scoped implementation work.
