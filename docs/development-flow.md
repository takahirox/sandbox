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
