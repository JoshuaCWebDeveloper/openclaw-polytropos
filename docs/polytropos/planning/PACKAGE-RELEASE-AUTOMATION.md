# Polytropos Package Release Automation

Status: draft
Date: 2026-06-18 UTC

## Goal

Make Polytropos core and every tracked Polytropos plugin follow one release automation model:

- maintain an explicit tracked package list
- resolve the latest published version for each tracked package
- map that version back to the Polytropos release that produced it
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

- Live plugin source repo: sibling repo `../polytropos-plugins`
- Current plugin packaging/deploy flow in that repo:
  - build plugin artifact into `dist/plugins/<id>`
  - deploy into `~/.openclaw/extensions/<id>`
- Current plugin npm release planning code in this repo (`scripts/lib/plugin-npm-release.ts`) targets `extensions/*` inside `openclaw-polytropos`, not the separate `polytropos-plugins` repo

## Proposed Model

### 1) Tracked package manifest

Define one machine-readable tracked package manifest in `openclaw-polytropos` describing every releasable unit:

- `openclaw` core package
- each tracked Polytropos plugin package

Each entry should include:

- logical id
- package name
- owning repo
- package directory
- package type (`core` or `plugin`)
- registry target
- artifact kind
- package-owned source pathset used for change detection

### 2) Published version -> release mapping

Each published package version needs a durable pointer back to the Polytropos release tag that produced it.

Recommended rule:

- package version is the Polytropos release version for releasable packages
- package metadata also records `polytroposReleaseTag`
- workflow uses that tag as the base ref for package diffing

That mapping should not live only in human convention. It should be explicit in machine-readable metadata.

### 3) Change detection

For each tracked package:

1. Resolve latest published package version from GitHub Packages
2. Resolve its recorded `polytroposReleaseTag`
3. Diff the package-owned pathset from that tag to `HEAD`
4. Build/publish only if changed
5. Otherwise carry forward the already-published package artifact reference

### 4) Core as a tracked published package

Apply the same model to core:

- treat `openclaw` as one tracked package
- publish it to GitHub Packages
- only publish when core-owned paths changed since the prior published Polytropos release for core
- keep the workflow output as a full package inventory, not just one tarball

### 5) Full package inventory artifact

Each workflow run should emit one canonical inventory artifact, e.g. `polytropos-package-inventory.json`, containing every tracked package:

- package name
- package type
- latest version
- repo
- base release tag used for diffing
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

### 1) The current plugin release logic in this repo is pointed at the wrong source tree

The current planner/checker in `openclaw-polytropos` scans `extensions/*` in this repo. The actual Polytropos plugin work now lives in `../polytropos-plugins/plugins/*`.

Consequence:

- current planner/checker code cannot just be extended slightly
- either new logic must target the sibling repo directly, or the release-planning code must be extracted into a shared library that both repos can use

### 2) The plugin packages are not publish-ready yet

In `polytropos-plugins`, current packages are mostly:

- `private: true`
- inconsistently versioned
- not consistently annotated for registry publishing
- not yet carrying explicit Polytropos-release metadata

Consequence:

- there is no reliable way yet to infer previous package release -> previous Polytropos release
- automation will be fragile until package metadata is normalized

### 3) GitHub Packages is storage, not the whole contract

The useful downstream primitive is not "latest package version exists in a registry". The useful primitive is "here is the exact installable artifact and metadata for every tracked package".

Consequence:

- the inventory artifact is the real source of truth
- GitHub Packages may back that inventory, but should not replace the inventory contract itself

### 4) Version-to-base-ref mapping must be explicit

"Use the previous published version as the base ref" only works if package versioning is perfectly aligned with Polytropos releases, or if explicit release-tag metadata exists.

Consequence:

- without explicit mapping, change detection will eventually diff against the wrong base
- that creates missed publishes or unnecessary publishes

### 5) Package-scoped diffing needs explicit ownership maps

Some changes that should trigger a package publish will live outside that package directory:

- shared scripts
- vendored runtime helpers
- release metadata helpers

Consequence:

- diffing only the package folder will miss real triggers
- diffing the whole repo defeats the selective-publish goal

### 6) `scripts/polytropos-release.mjs` assumes workflow artifacts today

The current core release script is built around GitHub Actions artifact discovery and download, not registry package resolution.

Consequence:

- switching to GitHub Packages is a real contract change
- the release script must move from "download artifact from run" to "consume package inventory and resolve locator"

### 7) Plugin install semantics still need one chosen standard

There are currently two overlapping models:

- deployed plugin payloads under `~/.openclaw/extensions`
- managed npm-installed plugins through OpenClaw plugin install/update flows

Consequence:

- "download plugin packages and install them in the expected way" is underspecified until one standard path is chosen for Polytropos-managed plugins

### 8) Cross-repo release orchestration will get more complex

The planning repo is `openclaw-polytropos`, but some tracked packages live in `polytropos-plugins`.

Consequence:

- release automation needs cross-repo package discovery, diffing, build, and metadata collection
- that is workable, but it is not a single-worktree problem anymore

## Recommendation

The direction makes sense, but the first milestone should be the package inventory contract, not the registry backend.

Recommended order:

1. define tracked package manifest in `openclaw-polytropos`
2. define explicit package metadata for `polytroposReleaseTag`
3. normalize plugin packages in `polytropos-plugins`
4. emit a full package inventory artifact from release automation
5. update downstream installer to consume that inventory
6. then decide whether GitHub Packages fully replaces workflow artifacts or merely backs them

That gets the architecture right first and keeps the storage/backend decision reversible.
