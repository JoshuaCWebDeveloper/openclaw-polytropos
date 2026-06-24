# Polytropos Core Releases

## Purpose

Stage and activate versioned Polytropos releases from a valid release branch.

## Definitions

- **Release branch:** `release/YYYY.M.D`
- **Release tag:** `vYYYY.M.D-poly.N`
- **Staging:** resolve the release inventory, ensure each needed package archive exists in the local package store, install the staged core package, and run the bundled deps helper plus plugin sync.
- **Activation:** the install flow now restarts the gateway at the end so the running process picks up the installed version immediately.

## Authoritative release store

- `~/polytropos/releases/v<version>-poly.<N>.json` — authoritative metadata for the release, downloaded from the same workflow run as the package artifacts
- `~/polytropos/releases/packages/` — authoritative local store for downloaded package archives, including core and tracked plugin packages
- `~/polytropos/releases/current.json` and `~/polytropos/releases/previous.json` — pointers refreshed after a successful install to match the prior `current` / `previous` release-record behavior, but targeting inventory files instead of tgz files

The inventory decides which package version and artifact locator belong to a release. The `releases/packages/` directory stores the local archive bytes. If the needed archive already exists there, release staging and plugin sync reuse it instead of redownloading or repacking it.

## Canonical release flow

1. Work from a valid `release/YYYY.M.D` branch.
2. Run the release script.
3. The script creates/pushes the next `v<version>-poly.<N>` tag automatically.
4. GitHub Actions publishes the tracked packages and builds the `polytropos-package-inventory-<tag>` artifact.
5. The script waits for CI, downloads the inventory and any missing package archives from the same run/package locators, installs the staged core package, and runs the bundled deps helper plus plugin sync.
6. The install flow restarts/reloads the gateway to activate it.

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

Use `--run-id` only to reuse an existing workflow run for the exact tag; the script skips tag creation/push in that mode and still downloads the tag-named inventory artifact. Add `--rerun-run` when the existing run must be rerun before the download.

## Rules

- The release script must run from a branch matching `release/YYYY.M.D`.
- `origin/main` is legacy and should not be used for release work.
- Package inventories in `~/polytropos/releases/` are authoritative release metadata.
- Versioned package archives in `~/polytropos/releases/packages/` are immutable local package bytes and should be reused on reruns.
- `current.json` and `previous.json` must behave like the old release-record pointers did, except they point to the correct inventory files.
- Do not treat `current.json` or `previous.json` as separate sources of truth. They are pointers into the inventory-based release store.

## Activation

Activation is part of the install flow.
After the staged package and inventory checks succeed, the script restarts the gateway automatically.

## Rollback

Rollback uses the same model:

1. restage the desired prior inventory if needed
2. reinstall the core package referenced by that inventory
3. restart/reload the gateway
