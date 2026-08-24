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
  const raw = match[1].replace(/\s+$/, "");
  const indent = raw.match(/^(\s*)\S/m)?.[1] ?? "";
  const body = indent.length === 0
    ? raw
    : raw.split("\n").map((line) => line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
  return `${body}\n`;
}

function writeStubBin(root: string, options: {
  readonly shortSha: string;
  readonly viewHit: boolean;
}): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
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
  view)
    if [ "${options.viewHit ? "1" : "0"}" = "1" ]; then
      printf '%s\\n' "$1" | sed 's/.*@//' 
      exit 0
    fi
    exit 1
    ;;
  publish)
    tag=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--tag" ]; then tag="$2"; shift 2; continue; fi
      shift
    done
    printf '%s\\n' "$tag" > "${root}/publish-tag"
    node -p 'require("./package.json").version' > "${root}/publish-version"
    printf 'publish\\n' > "${root}/npm-path"
    ;;
  dist-tag)
    # npm dist-tag add pkg@version tag
    sub="$1"; pkgver="$2"; tag="$3"
    if [ "$sub" != "add" ]; then echo "unexpected dist-tag $sub" >&2; exit 2; fi
    printf '%s\\n' "$pkgver" > "${root}/dist-tag-package"
    printf '%s\\n' "$tag" > "${root}/dist-tag-name"
    printf 'dist-tag\\n' > "${root}/npm-path"
    ;;
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
  "rev-parse --short=7 HEAD") echo "${options.shortSha}" ;;
  *) echo "unexpected git $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

function runStampBody(options: {
  readonly body: string;
  readonly channel: string;
  readonly viewHit: boolean;
  readonly shortSha: string;
}): {
  readonly root: string;
  readonly npmPath: string;
  readonly packageVersion: string;
  readonly publishTag?: string;
  readonly publishVersion?: string;
  readonly distTagPackage?: string;
  readonly distTagName?: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ak-publish-registry-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@akagilnc/pi-workflow-roles", version: "0.0.0" }),
  );
  const bin = writeStubBin(root, { shortSha: options.shortSha, viewHit: options.viewHit });
  const script = join(root, "stamp.sh");
  writeFileSync(script, options.body);
  execFileSync("bash", [script], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CHANNEL: options.channel,
      GITHUB_REF_NAME: "feat/dogfood",
      GITHUB_STEP_SUMMARY: join(root, "summary.md"),
    },
    encoding: "utf8",
  });
  const readOptional = (name: string): string | undefined => {
    try {
      return readFileSync(join(root, name), "utf8").replace(/\n$/, "");
    } catch {
      return undefined;
    }
  };
  const publishTag = readOptional("publish-tag");
  const publishVersion = readOptional("publish-version");
  const distTagPackage = readOptional("dist-tag-package");
  const distTagName = readOptional("dist-tag-name");
  return {
    root,
    npmPath: readOptional("npm-path") ?? "",
    packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string,
    ...(publishTag === undefined ? {} : { publishTag }),
    ...(publishVersion === undefined ? {} : { publishVersion }),
    ...(distTagPackage === undefined ? {} : { distTagPackage }),
    ...(distTagName === undefined ? {} : { distTagName }),
  };
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

test("publish-registry stamp body: missing version publishes under malicious CHANNEL + shortsha", () => {
  const body = stampStepRunBody(readFileSync(workflowPath, "utf8"));
  const malicious = 'x$(echo pwned)y; echo injected" `uname` ';
  const shortSha = "abc1234";
  const result = runStampBody({ body, channel: malicious, viewHit: false, shortSha });
  try {
    const expected = `0.1.9-${malicious}.${shortSha}`;
    assert.equal(result.npmPath, "publish");
    assert.equal(result.publishVersion, expected);
    assert.equal(result.publishTag, malicious);
    assert.equal(result.packageVersion, expected);
    assert.equal(result.distTagPackage, undefined);
    assert.equal(result.distTagName, undefined);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("publish-registry stamp body: existing version moves dist-tag only", () => {
  const body = stampStepRunBody(readFileSync(workflowPath, "utf8"));
  const channel = "dogfood";
  const shortSha = "def5678";
  const result = runStampBody({ body, channel, viewHit: true, shortSha });
  try {
    const expectedVersion = `0.1.9-${channel}.${shortSha}`;
    assert.equal(result.npmPath, "dist-tag");
    assert.equal(result.distTagPackage, `@akagilnc/pi-workflow-roles@${expectedVersion}`);
    assert.equal(result.distTagName, channel);
    assert.equal(result.packageVersion, expectedVersion);
    assert.equal(result.publishTag, undefined);
    assert.equal(result.publishVersion, undefined);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});
