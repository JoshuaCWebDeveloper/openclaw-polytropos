# Polytropos Development Procedure

## Purpose

Define how Polytropos feature work moves from plugin-first development to reviewed pull requests and release validation.

## Plugin-first contract

Follow the plugin contract first.

- Implement feature behavior in `polytropos-plugins` whenever possible.
- Limit core-fork changes to the smallest plugin-enabling seam allowed by policy.
- Do not land complete feature implementations in the fork.

See also:

- [`../plugin-contract.md`](../plugin-contract.md)
- [`../polytropos-events.md`](../polytropos-events.md)

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

## Release validation before merge

Substantial pull requests will often need to be tested by releasing them before they are merged.

1. Leave the pull request open.
2. Check out the current `release/YYYY.M.D` branch.
3. Merge the pull request branch into that release branch.
4. Build and validate on the release branch.
5. Follow the release procedure from the release branch.
6. Verify the released change in the running environment.
7. Merge the original pull request into `master` only after release validation succeeds.

## Release validation example

```bash
git fetch origin
git checkout release/YYYY.M.D
git pull --ff-only origin release/YYYY.M.D
git merge --no-ff origin/<type>/<short-description>
git push origin release/YYYY.M.D
node scripts/polytropos-release.mjs release
```

## Rules

- All commits intended for `master` must arrive through a pull request based on `origin/master`.
- Standard development pull requests target `master`, not a release branch.
- Large project pull requests may target a `feature/<project-name>` branch until the project is ready for `master`.
- Do not release from a development branch or from `master`.
- Do not merge a release branch back into `master`.
- `origin/main` is legacy and must not be used for development or release work.
- Keep each pull request focused and include the documentation required by the fork policy.

See also:

- [`./release.md`](./release.md)
- [`./update.md`](./update.md)
