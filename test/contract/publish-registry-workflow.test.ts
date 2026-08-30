import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const stampScriptPath = resolve(packageRoot, "scripts/publish-registry-stamp.sh");

function writeGitStub(bin: string, shortSha: string): void {
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
  chmodSync(join(bin, "git"), 0o755);
}

function writeNpmStub(bin: string, root: string, options: { readonly viewHit: boolean }): void {
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
    # Mirror real npm: reject non-semver so illegal channels cannot be washed green.
    node -e 'const v=process.argv[1]; if(!/^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(v)){console.error("Invalid version"); process.exit(1)} const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); p.version=v; fs.writeFileSync("package.json", JSON.stringify(p));' "$ver"
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
  chmodSync(join(bin, "npm"), 0o755);
}

function runStamp(options: {
  readonly channel: string;
  readonly viewHit: boolean;
  readonly shortSha: string;
  readonly useRealNpmVersion?: boolean;
}): {
  readonly root: string;
  readonly status: number;
  readonly stderr: string;
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
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeGitStub(bin, options.shortSha);
  // Malicious-channel case uses real npm for Invalid version; legal cases use the stub.
  if (!options.useRealNpmVersion) {
    writeNpmStub(bin, root, { viewHit: options.viewHit });
  }
  let status = 0;
  let stderr = "";
  try {
    execFileSync("bash", [stampScriptPath], {
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CHANNEL: options.channel,
        // Routing owns channel selection; stamp must not consult GITHUB_REF_NAME.
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      },
      encoding: "utf8",
    });
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    status = typeof err.status === "number" ? err.status : 1;
    stderr = `${err.stderr ?? ""}${err.stdout ?? ""}`;
  }
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
    status,
    stderr,
    npmPath: readOptional("npm-path") ?? "",
    packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string,
    ...(publishTag === undefined ? {} : { publishTag }),
    ...(publishVersion === undefined ? {} : { publishVersion }),
    ...(distTagPackage === undefined ? {} : { distTagPackage }),
    ...(distTagName === undefined ? {} : { distTagName }),
  };
}

test("malicious CHANNEL is data to real npm and fails Invalid version without shell execution", () => {
  const malicious = 'x$(echo pwned >PWND)y; echo injected" `uname` ';
  const shortSha = "abc1234";
  const result = runStamp({
    channel: malicious,
    viewHit: false,
    shortSha,
    useRealNpmVersion: true,
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid version/i);
    assert.equal(existsSync(join(result.root, "PWND")), false);
    assert.equal(result.npmPath, "");
    assert.equal(result.publishVersion, undefined);
    // package.json must not have been stamped to the malicious identity.
    assert.equal(result.packageVersion, "0.0.0");
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("legal missing-version publish carries next shortsha artifact identity", () => {
  const channel = "next";
  const shortSha = "abc1234";
  const result = runStamp({ channel, viewHit: false, shortSha });
  try {
    const expected = `0.1.9-${channel}.${shortSha}`;
    assert.equal(result.status, 0);
    assert.equal(result.npmPath, "publish");
    assert.equal(result.publishVersion, expected);
    assert.equal(result.publishTag, channel);
    assert.equal(result.packageVersion, expected);
    assert.equal(result.distTagPackage, undefined);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("legal existing-version moves next dist-tag only", () => {
  const channel = "next";
  const shortSha = "def5678";
  const result = runStamp({ channel, viewHit: true, shortSha });
  try {
    const expectedVersion = `0.1.9-${channel}.${shortSha}`;
    assert.equal(result.status, 0);
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

test("latest channel publishes monotonic version without shortsha suffix", () => {
  const result = runStamp({ channel: "latest", viewHit: false, shortSha: "abc1234" });
  try {
    const expected = "0.1.9";
    assert.equal(result.status, 0);
    assert.equal(result.npmPath, "publish");
    assert.equal(result.publishVersion, expected);
    assert.equal(result.publishTag, "latest");
    assert.equal(result.packageVersion, expected);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});
