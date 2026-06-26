# Polytropos Package Release Automation

Status: draft
Date: 2026-06-18 UTC

## Goal

Make Polytropos core and every tracked Polytropos plugin follow one release automation model:

- maintain a workflow-local tracked package list
- resolve the latest published version for each tracked package
- treat that version as the previous Polytropos release version for that package
- diff package-owned source since that base ref
- only build/publish packages that changed
- emit one workflow artifact listing the latest installable artifact for every tracked package
- let downstream install core and plugins from that package inventory

## Current State

### Core

- Repo: `openclaw-polytropos`
- Current packaging workflow: `.github/workflows/polytropos-build-pack.yml`
- Current output: GitHub Packages publications plus a package inventory artifact with GitHub Packages locators for tracked packages
- Current downstream install path: `scripts/polytropos-release.mjs`
- Current release script contract: find or reuse a tag workflow run, download `polytropos-package-inventory-<tag>`, stage package archives under `~/polytropos/releases/packages/`, install the staged core package, and run plugin sync from the same inventory

### Plugins

- Current plugin npm release planning code in this repo (`scripts/lib/plugin-npm-release.ts`) already provides a useful model for:
  - discovering publishable packages from package metadata
  - selecting changed packages from source paths
  - skipping already-published versions

## Proposed Model

### 1) Workflow-local tracked package list

Define one workflow-local list of tracked package names in `openclaw-polytropos`.

- `openclaw` core package
- each tracked Polytropos plugin package

Design rule:

- this list contains package names only
- it is strongly tied to the workflow
- it does not become a second metadata registry

Recommended storage:

- keep it in a small adjacent workflow-owned file that the workflow reads, rather than inline YAML
- that keeps the list easy to edit without mixing package names into workflow logic

Everything else should be derived from existing repo/package metadata and code layout:

- package path
- package type
- build/publish behavior
- version
- relevant source directories to compare
- artifact naming/locator shape

### 2) Published version -> release mapping

For this proposal, the Polytropos release is the package version.

That means:

- latest package version from GitHub Packages is the previous Polytropos release version for that package
- the workflow can use that version directly to determine the base ref

No extra release-tag mapping field is required if that invariant holds.

### 3) Change detection

For each tracked package:

1. Resolve latest published package version from GitHub Packages
2. Treat that version as the previous Polytropos release/base version for that package
3. Diff the relevant source directories for that package from that base ref to `HEAD`
4. Build/publish only if changed
5. Otherwise carry forward the already-published package artifact reference

Default implementation for plugin packages:

- scan `extensions/*/package.json`
- find the package whose `package.json.name` matches the tracked package name
- use that extension directory as the default diff root
- if needed, reuse the same path-to-extension matching pattern already used by `scripts/lib/changed-extensions.mjs`

So the simplest default rule is:

- tracked package name resolves to one extension package
- that extension directory is the diff root
- directory name can be used as a fallback when package-name matching is not needed

First-pass shared/global exception rule for plugin packages:

- if shared plugin packaging/runtime helper inputs change, republish all tracked plugin packages

Known shared/generated paths worth treating that way:

- `scripts/lib/plugin-npm-runtime-build.mjs`
- `scripts/lib/plugin-npm-package-manifest.mjs`
- `scripts/lib/plugin-npm-runtime-assets.mjs`
- `scripts/lib/static-extension-assets.mjs`
- `scripts/lib/bundled-plugin-build-entries.mjs`
- `src/config/bundled-channel-config-metadata.generated.ts`

### 4) Core as a tracked published package

Apply the same model to core:

- treat `openclaw` as one tracked package
- publish it to GitHub Packages
- keep the workflow output as a full package inventory, not just one tarball

Current implementation rule for core:

- for now, build and publish the core package on every Polytropos release
- do not block the inventory-first release flow on core change detection
- revisit core-specific diffing only after the package inventory contract and downstream install flow are stable

Default safe rule for core:

- it is acceptable to over-include core source paths
- when core-specific diffing is implemented later, use a broad core scope rather than trying to minimize it aggressively

### 5) Full package inventory artifact

Each workflow run should emit one canonical inventory artifact, e.g. `v2026.6.1-poly.58.json`, containing every tracked package:

- package name
- latest version
- base version used for diffing
- changed in this run
- published in this run
- direct artifact download URL
- integrity metadata

Unchanged packages should still appear in the inventory with their latest known installable locator.
That inventory file becomes the local release artifact.

### 6) Downstream installer model

Downstream should consume the inventory, not rediscover packages ad hoc.

Current flow:

1. Download the release inventory from the selected tag workflow run
2. Resolve core and tracked plugin package metadata from that inventory
3. Store downloaded package archives under `~/polytropos/releases/packages/`
4. Reuse any already-downloaded local archive for the same package/version instead of downloading or packing it again
5. Install core from the staged package archive
6. Run plugin sync across the previous release tag and current release tag using the same inventory

Implementation consequence:

- the release inventory is authoritative metadata, not an install archive
- `~/polytropos/releases/packages/` is the authoritative local package archive store for both core and plugins
- stale reruns should prefer local package archives when the inventory points at a package/version that is already stored

Implementation rule:

- reuse existing package release logic wherever possible
- only add the missing Polytropos-specific pieces

## Implementation Notes

### 1) Package-scoped diffing default

If "changes" means changes to the relevant source directories, the workflow needs a reliable way to derive those directories from a package name.

- for plugin packages, the simplest default is to resolve the package by matching `extensions/*/package.json` and then use that extension directory as the diff root
- if any packages also depend on shared/generated paths that should trigger publishes, those exceptions need to be documented explicitly

### 2) Host-side plugin install/update flow

The proposal says downstream will download plugin packages and install them "in the expected way", but that expected way should be stated explicitly in terms of the actual host-side install/update path.

- the doc should name the concrete host-side install/update flow that Polytropos-managed plugin packages will use

## Recommendation

The direction makes sense, but the first milestone should be the package inventory contract, not the registry backend.

Recommended order:

1. define the workflow-local tracked package name list
2. derive package metadata and source directories from existing code/package metadata
3. reuse existing package release logic wherever possible
4. emit the full workflow package/artifact list from release automation
5. update downstream installer to consume that workflow output

That keeps the workflow list minimal and avoids introducing a second metadata registry.
