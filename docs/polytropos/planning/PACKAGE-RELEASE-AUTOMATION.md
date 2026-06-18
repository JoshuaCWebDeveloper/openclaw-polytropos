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
- Current output: a release-tagged `openclaw` `.tgz` uploaded as a GitHub Actions artifact
- Current downstream install path: `scripts/polytropos-release.mjs`
- Current release script contract: find workflow run, download exact artifact, stage in `~/polytropos/releases/`, install globally

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

### 4) Core as a tracked published package

Apply the same model to core:

- treat `openclaw` as one tracked package
- publish it to GitHub Packages
- only publish when relevant core source paths changed since the prior published Polytropos release for core
- keep the workflow output as a full package inventory, not just one tarball

### 5) Full package inventory artifact

Each workflow run should emit one canonical inventory artifact, e.g. `polytropos-package-inventory.json`, containing every tracked package:

- package name
- latest version
- base version used for diffing
- changed in this run
- published in this run
- install/download locator
- integrity metadata

Unchanged packages should still appear in the inventory with their latest known installable locator.

### 6) Downstream installer model

Downstream should consume the inventory, not rediscover packages ad hoc.

Desired flow:

1. Download package inventory
2. Resolve core package locator from inventory
3. Install core via the normal package-install path
4. Resolve plugin package locators from inventory
5. Install/update plugins via the chosen standard plugin-install path

Implementation consequence:

- `scripts/polytropos-release.mjs` will need to consume the workflow’s package/artifact list instead of assuming a single core artifact download path

Implementation rule:

- reuse existing package release logic wherever possible
- only add the missing Polytropos-specific pieces

## Main Issues With This Proposal

### 1) Package-scoped diffing needs a clear default resolution rule

If "changes" means changes to the relevant source directories, the workflow needs a reliable way to derive those directories from a package name.

Consequence:

- for plugin packages, the simplest default is to resolve the package by matching `extensions/*/package.json` and then use that extension directory as the diff root
- if any packages also depend on shared/generated paths that should trigger publishes, those exceptions need to be documented explicitly

### 2) Host-side plugin install/update behavior still needs to be stated concretely

The proposal says downstream will download plugin packages and install them "in the expected way", but that expected way should be stated explicitly in terms of the actual host-side install/update path.

Consequence:

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
