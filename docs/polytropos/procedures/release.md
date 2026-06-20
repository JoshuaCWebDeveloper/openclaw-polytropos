# Polytropos Core Releases

## Purpose

Stage and activate versioned Polytropos releases from a valid release branch.

## Definitions

- **Release branch:** `release/YYYY.M.D`
- **Release tag:** `vYYYY.M.D-poly.N`
- **Staging:** download the CI-built release inventory into the authoritative release store, update `previous.json` / `current.json`, install from that inventory, and run the bundled deps helper.
- **Activation:** restart/reload the gateway so the running process uses the newly installed version.

## Authoritative release store

- `~/polytropos/releases/v<version>-poly.<N>.json` — immutable versioned release inventories
- `~/polytropos/releases/current.json` — symlink to the staged release inventory
- `~/polytropos/releases/previous.json` — symlink to the rollback release inventory

## Canonical release flow

1. Work from a valid `release/YYYY.M.D` branch.
2. Run the release script.
3. The script creates/pushes the next `v<version>-poly.<N>` tag automatically.
4. GitHub Actions builds the package artifacts referenced by the release inventory.
5. The script waits for CI, downloads the release inventory, stages it, installs from it, and runs the bundled deps helper.
6. Restart/reload the gateway to activate it.

## Canonical command

```bash
node scripts/polytropos-release.mjs release
```

## Optional overrides

```bash
node scripts/polytropos-release.mjs release --tag v2026.4.1-poly.24
node scripts/polytropos-release.mjs release --workflow polytropos-build-pack.yml
```

## Rules

- The release script must run from a branch matching `release/YYYY.M.D`.
- `origin/main` is legacy and should not be used for release work.
- Versioned release inventories in `~/polytropos/releases/` are immutable.
- Never overwrite `current.json` / `previous.json` via `cp`; they are symlinks.

## Activation

Activation is intentionally separate from staging.
After staging succeeds, restart/reload the gateway using the correct environment-specific procedure.

## Rollback

Rollback uses the same model:

1. point `current.json` back at the desired prior version (or restage it properly)
2. reinstall if needed
3. restart/reload the gateway
