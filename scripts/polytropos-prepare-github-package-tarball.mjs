#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function readArg(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return "";
  }
  const value = args[index + 1];
  if (!value) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const input = readArg(args, "--input");
  const output = readArg(args, "--output");
  const publishedName = readArg(args, "--published-name");
  const repositoryUrl = readArg(args, "--repository-url");
  const installNpmSpec = readArg(args, "--install-npm-spec");
  if (!input || !output || !publishedName || !repositoryUrl) {
    fail(
      "usage: node scripts/polytropos-prepare-github-package-tarball.mjs --input <tgz> --output <tgz> --published-name <name> --repository-url <url> [--install-npm-spec <spec>]",
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polytropos-ghpkg."));
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", path.resolve(input), "-C", extractDir], { stdio: "inherit" });
    const packageJsonPath = path.join(extractDir, "package", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.name = publishedName;
    packageJson.repository = { type: "git", url: repositoryUrl };
    packageJson.publishConfig = {
      ...(packageJson.publishConfig && typeof packageJson.publishConfig === "object"
        ? packageJson.publishConfig
        : {}),
      registry: "https://npm.pkg.github.com",
    };
    if (installNpmSpec) {
      packageJson.openclaw ??= {};
      packageJson.openclaw.install ??= {};
      packageJson.openclaw.install.npmSpec = installNpmSpec;
    }
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    execFileSync("tar", ["-czf", path.resolve(output), "-C", extractDir, "package"], {
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
