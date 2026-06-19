# Polytropos Package Release Automation

Status: draft
Date: 2026-06-18 UTC

## Goal

Make Polytropos core and every tracked Polytropos plugin follow one release automation model:

- maintain a workflow-local tracked package list
- derive tracked package versions from the tagged source checkout
- treat the previous Polytropos release tag as the diff base for tracked packages
- diff package-owned source since that base ref
- emit one workflow artifact listing the installable GitHub Actions artifact for every tracked package
- let downstream install core and plugins from that package inventory

## Current State

### Core

- Repo: `openclaw-polytropos`
- Current packaging workflow: `.github/workflows/polytropos-build-pack.yml`
- Current output: a release-tagged package inventory artifact plus same-run GitHub Actions package artifacts
- Current downstream install path: `scripts/polytropos-release.mjs`
- Current release script contract: find workflow run, download release inventory, stage in `~/polytropos/releases/`, install from that inventory

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

### 2) Release tag -> package mapping

For this proposal, the Polytropos release tag is the workflow's source of truth.

That means:

- the tracked package version comes from the tagged source checkout in this repo
- the previous Polytropos release tag is the base ref for change detection
- the inventory points at package artifacts uploaded by that release workflow run

No registry lookup is required for the first pass if that invariant holds.

### 3) Change detection

For each tracked package:

1. Resolve the tracked package version from the tagged source checkout
2. Treat the previous Polytropos release tag as the base ref for that package
3. Diff the relevant source directories for that package from that base ref to `HEAD`
4. Build/package tracked artifacts for the release run
5. Record the resulting GitHub Actions artifact locator in the inventory

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
- package it in the tagged GitHub Actions workflow run
- diff it against the prior Polytropos release tag for change reporting
- keep the workflow output as a full package inventory, not just one tarball
- keep the local release artifact as the inventory even when the core tarball is unchanged

Default safe rule for core:

- it is acceptable to over-include core source paths
- for the first pass, use a broad core scope rather than trying to minimize it aggressively

### 5) Full package inventory artifact

Each workflow run should emit one canonical inventory artifact, e.g. `v2026.6.1+poly.58.json`, containing every tracked package:

- package name
- latest version
- base version used for diffing
- changed in this run
- published in this run
- GitHub Actions artifact locator from the same workflow run
- integrity metadata

Tracked packages should still appear in the inventory with their same-run installable locator.
That inventory file becomes the local release artifact.

### 6) Downstream installer model

Downstream should consume the inventory, not rediscover packages ad hoc.

Desired flow:

1. Download the release inventory
2. Stage it locally as the authoritative release artifact for that release tag
3. Resolve the core package locator from the inventory
4. Install core via the normal package-install path
5. Resolve plugin package locators from the inventory
6. Install/update plugins via the chosen standard plugin-install path

Implementation consequence:

- `scripts/polytropos-release.mjs` will need to treat the release inventory as the local release artifact instead of assuming a single core artifact download path
- a local staging/cache directory like `~/polytropos/releases/plugins` is a reasonable default for downloaded plugin artifacts before install

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

The direction makes sense, and the first milestone should stay the package inventory contract rather than any registry backend.

Recommended order:

1. define the workflow-local tracked package name list
2. derive package metadata and source directories from existing code/package metadata
3. reuse existing package release logic wherever possible
4. emit the full workflow package/artifact list from release automation
5. update downstream installer to consume that workflow output

That keeps the workflow list minimal and avoids introducing a second metadata registry.
