---
name: Issue
about: Report a problem or propose a change
title: ""
labels: ""
assignees: ""
---

## Problem

Describe the problem.

## Expected outcome

Describe what should be true when the issue is resolved.

Default to completion criteria an AI agent can execute and verify. Require human checks only when necessary; explain why and the expected result, and distinguish optional validation from mandatory criteria. See the [development guidance](https://github.com/takahirox/sandbox/blob/main/docs/development-flow.md#1-start-with-an-issue).

### Pre-merge acceptance criteria

List mandatory acceptance criteria that are achievable and verifiable before merge. Preserve all implementation requirements and applicable pre-merge tests.

For a merge-triggered deployment, validate the code/configuration, local build, and applicable automated tests before merge. Deployment and verification of the newly published site must not be prerequisites for pre-merge PR approval.

### Required post-merge verification

Record checks possible only after merge separately when the actual change needs them, or state that none are required. For a merge-triggered deployment, check deployment success and verify the newly published site after merge. Report pending, not-run, or environment-blocked checks honestly.

Follow the [merge, closure, and follow-up lifecycle](https://github.com/takahirox/sandbox/blob/main/docs/development-flow.md#5-merge): close a fully implemented Issue after successful merge, then record required post-merge evidence. Track discovered defects in new or existing linked Issues; pending post-merge-only checks do not make implementation partial or require keeping this Issue open.

## Context

Add any relevant context, examples, logs, or related issues.
