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

If the change is intentionally partial, the Pull Request should say so and the Issue should remain open.

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

## Check Validation Timing

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Require all implementation requirements and applicable pre-merge tests to be satisfied. Checks possible only after merge must not be prerequisites for pre-merge Pull Request approval.

For example, for a merge-triggered deployment, review the code/configuration, local build results, and applicable automated test results before merge. Deployment success and verification of the newly published site are required post-merge checks, recorded separately and reported as pending until performed.

Confirm that the Pull Request accurately reports what was validated, what failed or was not run, and which required post-merge checks remain pending. Pending post-merge verification is not missing implementation and does not justify claiming those checks passed. Follow the [development flow](development-flow.md#6-perform-required-post-merge-verification) to perform and report them after merge.

## Review Outcome

A Pull Request is ready to merge when:

- it implements all requirements of the Issue it claims to resolve
- it does not introduce unjustified scope or complexity
- the implementation is correct and appropriately validated
- mandatory pre-merge acceptance criteria are satisfied, and required post-merge verification is recorded separately as pending until performed

If any of these conditions are not met, request changes and review again after revision.
