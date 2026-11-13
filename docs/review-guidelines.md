# Review Guidelines

The purpose of review is not only to check whether a change works. It is also to verify that the change is the right response to the Issue that motivated it.

These guidelines are particularly important when reviewing AI-generated changes.

## Review Against the Issue

Start by reading the source Issue.

Treat the Issue as the reference for the intended problem and expected outcome.

Ask:

> Is the Pull Request a complete and appropriately scoped solution to this Issue?

## Check for Missing Work

Verify that the Pull Request addresses all parts of the Issue that it claims to resolve.

Do not approve a Pull Request as closing an Issue when important requirements remain unimplemented.

If the change is intentionally partial, the Pull Request must state the remaining scope and must not automatically close the parent Issue. Pending post-merge-only verification does not make an otherwise complete implementation partial.

## Check for Unnecessary Work

Verify that the Pull Request does not go beyond what the Issue requires without a clear reason.

Watch for:

- unnecessary abstractions
- speculative extensibility
- unrelated refactoring
- new frameworks or subsystems that are not required
- additional policies or configuration with no demonstrated need

AI agents can over-engineer solutions. Do not treat additional complexity as automatically beneficial.

Prefer the smallest design that completely solves the stated problem.

## Check the Result

Also verify the ordinary quality of the change:

- behavior matches the expected outcome
- implementation is coherent with the existing architecture
- validation is sufficient for the change
- documentation is updated when the change affects documented behavior

Review interface changes against the [UI/UX principles](../README.md#uiux).

Apply the [test and CI performance principles](development-flow.md#test-and-ci-performance-principles). Review additional defect coverage, duplication, and execution/maintenance cost together:

> Does this change provide sufficient confidence with the lightest appropriate validation, without redundant execution?

## Check Validation Timing

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Require all implementation requirements and applicable pre-merge tests to be satisfied. Checks possible only after merge must not be prerequisites for pre-merge Pull Request approval.

Preserve `Closes #N` for a fully implemented Issue whose mandatory pre-merge acceptance is satisfied. Do not request removing it, keep the source Issue open, or withhold approval solely because post-merge-only verification is pending. Such requests cause a Review → Fix → Publish → Review loop when ProjectWeave restores the closing reference. Missing implementation, mandatory pre-merge tests, required protections, and genuinely necessary pre-merge human acceptance remain blockers.

For example, for a merge-triggered deployment, review the code/configuration, local build results, and applicable automated test results before merge. Deployment success and verification of the newly published site are required post-merge checks, recorded separately and reported as pending until performed.

Confirm that required post-merge checks are justified by the actual change. Documentation-only edits do not introduce routine manual approval, physical-device, heavyweight-model-download, or deployment gates; use the documentation checks in the linked test and CI performance principles.

Confirm that the Pull Request accurately reports what was validated, what failed or was not run, and which required post-merge checks remain pending or environment-blocked. Follow the [merge and closure lifecycle](development-flow.md#5-merge), then [record evidence and track discovered defects in new or existing linked Issues](development-flow.md#6-perform-required-post-merge-verification). Closing the original Issue does not claim pending checks passed; an unavailable environment alone does not establish a product defect. Do not reopen the original Issue solely for post-merge follow-up.

## Review Outcome

A Pull Request is ready to merge when:

- it implements all requirements of the Issue it claims to resolve
- it does not introduce unjustified scope or complexity
- the implementation is correct and appropriately validated
- mandatory pre-merge acceptance criteria are satisfied, and required post-merge verification is recorded separately as pending until performed

If any of these conditions are not met, request changes and review again after revision.
