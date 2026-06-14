# Polytropos Development Procedure

## Purpose

Define how Polytropos feature work moves from plugin-first development to reviewed pull requests and release validation.

## Plugin-first contract

The [`plugin contract`](../plugin-contract.md) must be followed.

## Use Pull Requests Exclusively

`master` is write-protected.

- Do not commit directly to `master`.
- Start each pull request from `origin/master`.
- Push the branch to origin and open a pull request targeting `master`.
- Keep review, CI, and follow-up fixes on the same pull request branch.

## Canonical example

```bash
git fetch origin
git checkout -b <type>/<short-description> origin/master

# Make and validate the change.

git push -u origin <type>/<short-description>
gh pr create --base master --head <type>/<short-description>
```

## Large project flow

Large efforts that will span multiple pull requests should get a dedicated `feature/<project-name>` branch from `origin/master`.

1. Create and push the long-lived project branch.
2. Base project pull request branches on that `feature/<project-name>` branch.
3. Target those pull requests at the feature branch until the larger effort is ready to merge to `master`.

## Releasing PRs for Validation

Pull requests will often need to be tested by releasing them before they are merged. Follow the [release procedure](./release.md):

1. Leave the pull request open.
2. Check out the current `release/YYYY.M.D` branch.
3. Merge the pull request branch into that release branch.
4. Follow the release procedure from the release branch.

## Rules

- All commits intended for `master` must arrive through a pull request based on `origin/master`.
- Standard development pull requests target `master`, not a release branch.
- Large project pull requests may target a `feature/<project-name>` branch until the project is ready for `master`.
- Keep each pull request focused and include the documentation required by the fork policy.
