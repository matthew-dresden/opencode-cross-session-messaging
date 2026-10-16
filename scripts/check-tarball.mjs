#!/usr/bin/env node
// Tarball leak gates for opencode-cross-session-messaging.
//
// Packs the package (npm pack), then asserts the tarball matches the
// package.json "files" allowlist policy and contains no secret material.
// This package ships TypeScript source directly (main: src/index.ts), so
// the shippable surface is: package.json, README.md, README.zh-CN.md,
// SKILL.md, LICENSE, NOTICE, the tui.tsx entry file, src/ (built or
// source), and the built web/dist/ dashboard output.
//   FORBIDDEN paths: test/, .github/, ci/, scripts/, web/ sources, any
//   *.test.* file, any *.md beyond the three shipped docs, any dotfile,
//   any .env file, lockfiles and tsconfig.
//   FORBIDDEN content: private key blocks, cloud API token shapes, and
//   key=value secret assignments in text files.
//
// Usage: node scripts/check-tarball.mjs
// Exit 0 on success; exit 1 with all violations listed on failure.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "SKILL.md",
  "LICENSE",
  "NOTICE",
  "tui.tsx",
];

const FORBIDDEN_PATH_RULES = [
  { test: /^package\/test\//, reason: "test/ must not ship in the tarball" },
  { test: /^package\/\.github\//, reason: ".github/ must not ship in the tarball" },
  { test: /^package\/ci\//, reason: "ci/ release tooling must not ship in the tarball" },
  { test: /^package\/scripts\//, reason: "scripts/ check tooling must not ship in the tarball" },
  { test: /^package\/web\/(?!dist\/)/, reason: "web/ sources must not ship (only built web/dist/)" },
  { test: /\.test\./, reason: "test files must not ship in the tarball" },
  {
    test: /^package\/(?!package\.json$|README\.md$|README\.zh-CN\.md$|SKILL\.md$|LICENSE$|NOTICE$|tui\.tsx$)[^/]*\.md$/,
    reason: "no *.md beyond README.md, README.zh-CN.md, SKILL.md may ship",
  },
  { test: /^package\/\./, reason: "no dotfiles may ship" },
  { test: /\.env/, reason: "env files must not ship" },
  { test: /(^|\/)bun\.lock$/, reason: "lockfile must not ship in the tarball" },
  { test: /(^|\/)tsconfig\.json$/, reason: "tsconfig must not ship in the tarball" },
];

const SECRET_PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  {
    name: "key=value secret assignment",
    re: /^\s*(?:api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i,
  },
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (result.status !== 0) {
    process.stderr.write(
      `FATAL: ${cmd} ${args.join(" ")} failed (exit ${result.status})\n${result.stderr ?? ""}\n`
    );
    process.exit(1);
  }
  return result;
}

function main() {
  const workdir = mkdtempSync(join(tmpdir(), "csm-tarball-"));
  let packed;
  try {
    run("npm", ["pack", "--pack-destination", workdir], {
      cwd: process.cwd(),
    });
    // Locate the produced tarball directly in the pack destination rather
    // than parsing npm's human-readable stdout.
    const produced = readdirSync(workdir).filter((name) => name.endsWith(".tgz"));
    if (produced.length !== 1) {
      process.stderr.write(
        `FATAL: expected exactly one tarball in ${workdir}, found: ${JSON.stringify(produced)}\n`
      );
      process.exit(1);
    }
    packed = join(workdir, produced[0]);

    const listing = run("tar", ["-tzf", packed]).stdout;
    const entries = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));

    const violations = [];

    // Path allowlist / denylist checks.
    for (const entry of entries) {
      for (const rule of FORBIDDEN_PATH_RULES) {
        if (rule.test.test(entry)) {
          violations.push(`FORBIDDEN PATH: ${entry} (${rule.reason})`);
        }
      }
    }

    const names = new Set(entries.map((entry) => entry.replace(/^package\//, "")));
    for (const required of REQUIRED_FILES) {
      if (!names.has(required)) {
        violations.push(`MISSING REQUIRED FILE: ${required}`);
      }
    }
    const srcEntries = entries.filter((entry) => /^package\/src\/.+/.test(entry));
    if (srcEntries.length === 0) {
      violations.push("MISSING src/: tarball has no plugin source");
    }
    const distEntries = entries.filter((entry) => /^package\/web\/dist\/.+/.test(entry));
    if (distEntries.length === 0) {
      violations.push(
        "MISSING web/dist/: tarball has no dashboard build output (run bun run dashboard:build first)"
      );
    }

    // Content leak scan on text members.
    for (const entry of entries) {
      const show = run("tar", ["-xzOf", packed, entry], { maxBuffer: 32 * 1024 * 1024 });
      const content = show.stdout;
      if (content.includes("\u0000")) {
        continue; // binary member, pattern scan not meaningful
      }
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(content)) {
          violations.push(`SECRET PATTERN (${name}) in tarball member: ${entry}`);
        }
      }
    }

    if (violations.length > 0) {
      process.stderr.write(`tarball check FAILED with ${violations.length} violation(s):\n`);
      for (const violation of violations) {
        process.stderr.write(`  - ${violation}\n`);
      }
      process.exit(1);
    }

    process.stdout.write(
      `tarball check: OK (${entries.length} members, ${srcEntries.length} src files, ${distEntries.length} web/dist files, no leaks)\n`
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
