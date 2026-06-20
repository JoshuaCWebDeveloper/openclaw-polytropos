# Polytropos Core Releases

## Purpose

Stage and activate versioned Polytropos releases from a valid release branch.

## Definitions

- **Release branch:** `release/YYYY.M.D`
- **Release tag:** `vYYYY.M.D-poly.N`
- **Staging:** download the CI-built core tarball and package inventory into the authoritative release store, update `previous.tgz` / `current.tgz`, install the staged tarball, and run the bundled deps helper plus plugin sync.
- **Activation:** restart/reload the gateway so the running process uses the newly installed version.

## Authoritative release store

- `~/polytropos/releases/v<version>-poly.<N>.tgz` — immutable versioned core tarballs
- `~/polytropos/releases/v<version>-poly.<N>.package-inventory.json` — package inventory downloaded from the same workflow run
- `~/polytropos/releases/current.tgz` — symlink to the staged core tarball
- `~/polytropos/releases/previous.tgz` — symlink to the rollback core tarball

## Canonical release flow

1. Work from a valid `release/YYYY.M.D` branch.
2. Run the release script.
3. The script creates/pushes the next `v<version>-poly.<N>` tag automatically.
4. GitHub Actions builds `openclaw-tgz-<tag>` and `polytropos-package-inventory-<tag>` artifacts.
5. The script waits for CI, downloads both artifacts from the same run, stages them, installs the staged tarball, and runs the bundled deps helper plus plugin sync.
6. Restart/reload the gateway to activate it.

## Canonical command

```bash
node scripts/polytropos-release.mjs release
```

## Optional overrides

```bash
node scripts/polytropos-release.mjs release --tag v2026.4.1-poly.24
node scripts/polytropos-release.mjs release --workflow polytropos-build-pack.yml
node scripts/polytropos-release.mjs release --tag v2026.4.1-poly.24 --run-id 123456789
node scripts/polytropos-release.mjs release --tag v2026.4.1-poly.24 --run-id 123456789 --rerun-run
```

Use `--run-id` only to reuse an existing workflow run for the exact tag; the script skips tag creation/push in that mode and still downloads the tag-named tarball and inventory artifacts. Add `--rerun-run` when the existing run must be rerun before the download.

## Rules

- The release script must run from a branch matching `release/YYYY.M.D`.
- `origin/main` is legacy and should not be used for release work.
- Versioned core tarballs and package inventories in `~/polytropos/releases/` are immutable.
- Never overwrite `current.tgz` / `previous.tgz` via `cp`; they are symlinks.

## Activation

Activation is intentionally separate from staging.
After staging succeeds, restart/reload the gateway using the correct environment-specific procedure.

## Rollback

Rollback uses the same model:

1. point `current.tgz` back at the desired prior version (or restage it properly)
2. reinstall if needed
3. restart/reload the gateway
