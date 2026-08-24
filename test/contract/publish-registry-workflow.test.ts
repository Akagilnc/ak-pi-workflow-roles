import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const workflowPath = resolve(packageRoot, ".github/workflows/publish-registry.yml");

function stampStepRunBody(source: string): string {
  // Real stamp step body after `run: |` — CHANNEL is bound only via step env above it.
  const match = source.match(
    /^\s+-\s+name:\s+Stamp version and publish \(OIDC\)\n[\s\S]*?^\s+run:\s*\|\s*\n([\s\S]*)$/m,
  );
  assert.ok(match?.[1], "stamp step run body must exist in publish-registry.yml");
  // Block scalar content is indented under run:|; strip the common leading indent.
  const raw = match[1].replace(/\s+$/, "");
  const indent = raw.match(/^(\s*)\S/m)?.[1] ?? "";
  const body = indent.length === 0
    ? raw
    : raw.split("\n").map((line) => line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
  return `${body}\n`;
}

test("publish-registry channel arrives via step env, not shell source interpolation", () => {
  const source = readFileSync(workflowPath, "utf8");
  assert.match(source, /^\s+env:\s*$/m);
  assert.match(source, /^\s+CHANNEL:\s*\$\{\{\s*github\.event\.inputs\.channel/m);
  const body = stampStepRunBody(source);
  assert.equal(
    body.includes("github.event.inputs.channel"),
    false,
    "channel expression must not be expanded into shell source",
  );
});

test("publish-registry stamp step treats malicious CHANNEL as data and unique prerelease sha", () => {
  const source = readFileSync(workflowPath, "utf8");
  const body = stampStepRunBody(source);
  assert.match(body, /VERSION="\$VERSION-\$CHANNEL\.\$\(git rev-parse --short=7 HEAD\)"/);
  assert.equal(body.includes('VERSION="$VERSION-$CHANNEL.0"'), false);
  assert.match(body, /npm dist-tag add "\$PACKAGE_NAME@\$VERSION" "\$CHANNEL"/);

  const malicious = 'x$(echo pwned)y; echo injected" `uname` ';
  const shortSha = "abc1234";
  const root = mkdtempSync(join(tmpdir(), "ak-publish-registry-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@akagilnc/pi-workflow-roles", version: "0.0.0" }),
    );
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Stub only external commands the extracted body invokes; body text is the workflow true source.
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
set -e
cmd="$1"
shift
case "$cmd" in
  --version) echo "11.5.1" ;;
  version)
    ver="$1"
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.version=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(p));' "$ver"
    echo "$ver"
    ;;
  view) exit 1 ;;
  publish)
    tag=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--tag" ]; then tag="$2"; shift 2; continue; fi
      shift
    done
    printf '%s\\n' "$tag" > "${root}/publish-tag"
    node -p 'require("./package.json").version' > "${root}/publish-version"
    ;;
  dist-tag) echo "unexpected dist-tag" >&2; exit 2 ;;
  *) echo "unexpected npm $cmd" >&2; exit 2 ;;
esac
`,
    );
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
set -e
case "$*" in
  "rev-list --count HEAD") echo "9" ;;
  "rev-parse --short=7 HEAD") echo "${shortSha}" ;;
  *) echo "unexpected git $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "git"), 0o755);

    const script = join(root, "stamp.sh");
    writeFileSync(script, body);
    execFileSync("bash", [script], {
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CHANNEL: malicious,
        GITHUB_REF_NAME: "feat/dogfood",
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      },
      encoding: "utf8",
    });

    const publishedVersion = readFileSync(join(root, "publish-version"), "utf8").replace(/\n$/, "");
    const publishedTag = readFileSync(join(root, "publish-tag"), "utf8").replace(/\n$/, "");
    assert.equal(publishedVersion, `0.1.9-${malicious}.${shortSha}`);
    assert.equal(publishedTag, malicious);
    assert.equal(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
      publishedVersion,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
