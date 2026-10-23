import { build } from "esbuild";
import { PUBLIC_ROLE_RECORDS } from "../../src/packaged-role-registry.ts";
import { AUDITOR_SESSION_MATERIALS } from "../../src/auditor-soul.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "../../src/public-cli/registry.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, test } from "vitest";
import { promisify } from "node:util";
import { worktreeTempPrefix, packIsolatedPackage } from "../helpers/environment-fixtures.ts";

import {
  packageRoot,
} from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

/** Registry-settled package identity (docs/npm-identity.md). */
const SETTLED_PACKAGE_NAME = "@akagilnc/pi-workflow-roles";

const CANONICAL_APACHE_2_0 = await readFile(
  resolve(packageRoot, "test/fixtures/licenses/Apache-2.0.txt"),
  "utf8",
);

const HOST_PEERS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;

interface ExtractedPack {
  root: string;
  packDestination: string;
  packageJson: {
    name: string;
    license?: string;
    bin?: Record<string, string>;
    pi?: { extensions?: unknown[] };
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  licenseText: string;
  thirdPartyNoticeText: string;
  paths: string[];
}

/**
 * One-shot pack owned by this file: pack destination + extract root are
 * self-owned sibling fixtures; cleaned after assertions (and on extract failure).
 * No cross-process cache / lock / ready protocol (#685 C4).
 */
async function extractPackedArtifact(): Promise<ExtractedPack> {
  const packDestination = await mkdtemp(worktreeTempPrefix("ak-pack-dest-"));
  const root = await mkdtemp(worktreeTempPrefix("ak-pack-meta-"));
  try {
    const pack = await packIsolatedPackage(packDestination);
    await execFileAsync("tar", ["-xzf", pack.tarball, "-C", root]);
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package/package.json"), "utf8"),
    ) as ExtractedPack["packageJson"];
    const licenseText = await readFile(resolve(root, "package/LICENSE"), "utf8");
    const thirdPartyNoticeText = await readFile(
      resolve(root, "package/THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    return {
      root,
      packDestination,
      packageJson,
      licenseText,
      thirdPartyNoticeText,
      paths: pack.files.map((file) => file.path),
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const path of [root, packDestination]) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "pack extract failed and cleanup failed", {
      cause: error,
    });
  }
}

async function disposeExtracted(fixture: ExtractedPack): Promise<void> {
  const failures: unknown[] = [];
  for (const path of [fixture.root, fixture.packDestination]) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "npm-identity pack fixture cleanup failed");
  }
}

/**
 * #420 整改：元数据断言全部落在一次解包的只读不可变产物上（解包 8 次 → 1 次，
 * 不触「独立契约塞共享可变状态」禁令）。本文件拥有 pack 临时根完整生命周期。
 */
const extracted = await extractPackedArtifact();
afterAll(async () => {
  await disposeExtracted(extracted);
});

/**
 * License identity: project license authority stays Apache-2.0 alone; Matt's
 * third-party notices remain separate; package name is the
 * registry-settled identity.
 */
test("packed artifact carries the settled license identity", async () => {
  assert.equal(extracted.packageJson.name, SETTLED_PACKAGE_NAME);
  assert.equal(extracted.packageJson.license, "Apache-2.0");
  assert.ok(
    extracted.paths.includes("LICENSE"),
    "npm pack file list must include LICENSE",
  );
  assert.equal(extracted.licenseText, CANONICAL_APACHE_2_0);

  assert.ok(
    extracted.paths.includes("THIRD_PARTY_NOTICES.md"),
    "npm pack file list must include THIRD_PARTY_NOTICES.md",
  );
  // Keyed package metadata: project license authority stays Apache-2.0 alone.
  assert.notEqual(extracted.thirdPartyNoticeText, extracted.licenseText);
});

/** Check the real pack against runtime declarations, not a copied inventory. */
test("packed runtime resolves its materials, modules and CLI bin", async () => {
  const materials = new Set([
    ...PUBLIC_ROLE_RECORDS.flatMap((record) => [...record.sessionMaterials]),
    ...Object.values(AUDITOR_SESSION_MATERIALS).flat(),
  ]);
  for (const path of materials) {
    assert.equal(extracted.paths.includes(path), true, path);
  }

  // Resolve actual shipped import edges, including the explicit Pi entrypoint.
  // Unlike the fresh-build closure test, this catches npm files exclusions.
  await build({
    absWorkingDir: resolve(extracted.root, "package"),
    entryPoints: [
      INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
      ...extracted.paths.filter((path) => path.startsWith("dist/") && /\.(?:m?js)$/.test(path)),
    ],
    outdir: resolve(extracted.root, "closure-check"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  const bin = extracted.packageJson.bin?.["ak-role"];
  assert.equal(typeof bin, "string");
  await execFileAsync(process.execPath, [resolve(extracted.root, "package", bin!), "--help"]);

  // Manifest load fields: bin mapping and empty auto-extension list (ADR 0052:
  // package auto-registration stays empty; explicit entrypoint owns loading).
  assert.deepEqual(extracted.packageJson.pi?.extensions ?? ["missing"], []);
});

// #685: private npm install of packed artifact culled — host install surface.
// Peer optional/* declarations stay as pack-metadata call-input asserts only.
// C3 §H: ordinary npm install 后 HOST_PEERS 路径 ENOENT 未结（不是本元数据案，
// 也不是 Pi 私有 bin 安装）— docs/research/issue-685-c3-deleted-contract-handoff.md.
test("packed artifact declares Pi host peers as optional star peers", () => {
  for (const name of HOST_PEERS) {
    assert.equal(extracted.packageJson.peerDependencies?.[name], "*");
    assert.equal(extracted.packageJson.peerDependenciesMeta?.[name]?.optional, true);
  }
});
