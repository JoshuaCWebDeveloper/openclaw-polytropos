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

This list should contain names only. It should not become a second metadata registry.

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

## Main Issues With This Proposal

### 1) The workflow-local tracked package list should stay minimal

The tracked package list should be strongly tied to the workflow and contain package names only.

Consequence:

- the workflow should derive package metadata from existing package.json/code layout instead of introducing a second source of truth
- any proposal that turns this into a richer manifest is probably over-designed

### 2) Package-scoped diffing needs a reliable way to derive relevant source directories

If "changes" means changes to the relevant source directories, the workflow needs a reliable way to derive those directories from a package name.

Consequence:

- simple package-directory rules may be enough
- but any shared/generated source paths that matter need to be accounted for, or the workflow will miss publish triggers

### 3) Existing package release logic should be reused as much as possible

This repo already has useful release-selection logic for publishable packages.

Consequence:

- the workflow should reuse existing package release logic wherever possible
- only the missing Polytropos-specific pieces should be added

### 4) `scripts/polytropos-release.mjs` still needs to change downstream

The current core release script is built around GitHub Actions artifact discovery and download, not registry package resolution.

Consequence:

- even with GitHub Packages as source of truth, downstream still needs a clean handoff artifact
- the release script must move from "download one core artifact from one run" to "consume the workflow’s package/artifact list"

### 5) Host-side plugin install/update logic is the main place that needs source-aware behavior

There are currently two overlapping models:

- deployed plugin payloads under `~/.openclaw/extensions`
- managed npm-installed plugins through OpenClaw plugin install/update flows

Consequence:

- "download plugin packages and install them in the expected way" is still underspecified until one standard path is chosen for Polytropos-managed plugins

## Recommendation

The direction makes sense, but the first milestone should be the package inventory contract, not the registry backend.

Recommended order:

1. define the workflow-local tracked package name list
2. derive package metadata and source directories from existing code/package metadata
3. reuse existing package release logic wherever possible
4. emit the full workflow package/artifact list from release automation
5. update downstream installer to consume that workflow output

That keeps the workflow list minimal and avoids introducing a second metadata registry.
