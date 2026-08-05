import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import {
  getSharedIsolatedPack,
  packageRoot,
} from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

/** Registry-settled package identity (docs/npm-identity.md). */
const SETTLED_PACKAGE_NAME = "@akagilnc/pi-workflow-roles";

const CANONICAL_APACHE_2_0 = await readFile(
  resolve(packageRoot, "test/fixtures/licenses/Apache-2.0.txt"),
  "utf8",
);
const UPSTREAM_MATT_MIT = await readFile(
  resolve(packageRoot, "test/fixtures/licenses/matt-pocock-skills-MIT.txt"),
  "utf8",
);

const EXPECTED_PEERS = {
  "@earendil-works/pi-ai": "~0.83.0",
  "@earendil-works/pi-coding-agent": "~0.83.0",
  typebox: ">=1.3.7 <=1.3.8",
} as const;

interface ExtractedPack {
  root: string;
  packageJson: {
    name: string;
    license?: string;
    peerDependencies?: Record<string, string>;
  };
  licenseText: string;
  thirdPartyNoticeText: string;
  paths: string[];
}

async function extractPackedArtifact(): Promise<ExtractedPack> {
  const pack = await getSharedIsolatedPack();
  const root = await mkdtemp(resolve(tmpdir(), "ak-pack-meta-"));
  try {
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
      packageJson,
      licenseText,
      thirdPartyNoticeText,
      paths: pack.files.map((file) => file.path),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Single owner for packed-artifact extract + dispose. Callers must not rm root.
 */
async function withExtractedPack<T>(
  scenario: (extracted: ExtractedPack) => Promise<T>,
): Promise<T> {
  const extracted = await extractPackedArtifact();
  return await withPrimaryAwareCleanup(
    async () => scenario(extracted),
    async () => {
      await rm(extracted.root, { recursive: true, force: true });
    },
  );
}

test("packed artifact carries complete Apache-2.0 LICENSE and matching license field", async () => {
  await withExtractedPack(async (extracted) => {
    assert.equal(extracted.packageJson.license, "Apache-2.0");
    assert.ok(
      extracted.paths.includes("LICENSE"),
      "npm pack file list must include LICENSE",
    );
    assert.equal(extracted.licenseText, CANONICAL_APACHE_2_0);
  });
});

test("packed artifact keeps Matt MIT as a separate complete third-party notice", async () => {
  await withExtractedPack(async (extracted) => {
    assert.ok(
      extracted.paths.includes("THIRD_PARTY_NOTICES.md"),
      "npm pack file list must include THIRD_PARTY_NOTICES.md",
    );
    // Keyed package metadata: project license authority stays Apache-2.0 alone.
    assert.notEqual(extracted.packageJson.license, "MIT");
    assert.notEqual(
      extracted.packageJson.license,
      "Apache-2.0 OR MIT",
    );
    assert.notEqual(
      extracted.packageJson.license,
      "(Apache-2.0 OR MIT)",
    );
    assert.notEqual(extracted.thirdPartyNoticeText, extracted.licenseText);
    // Exact license artifact seam — complete upstream MIT text, not free-form prose.
    assert.ok(
      extracted.thirdPartyNoticeText.includes(UPSTREAM_MATT_MIT.trim()),
      "third-party notice must embed the complete upstream Matt Pocock MIT text",
    );
  });
});

test("packed artifact name is the registry-settled identity", async () => {
  await withExtractedPack(async (extracted) => {
    assert.equal(extracted.packageJson.name, SETTLED_PACKAGE_NAME);
  });
});

test("packed peerDependencies use explicit evidence-bounded ranges, not wildcards", async () => {
  await withExtractedPack(async (extracted) => {
    const peers = extracted.packageJson.peerDependencies;
    assert.ok(peers, "packed package.json must declare peerDependencies");
    for (const [name, range] of Object.entries(EXPECTED_PEERS)) {
      assert.equal(typeof peers[name], "string", `${name} peer must be a string`);
      assert.notEqual(peers[name], "*", `${name} peer must not be wildcard`);
      assert.equal(
        peers[name],
        range,
        `${name} peer must match the evidence-bounded range`,
      );
    }

    const sourceManifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      name: string;
      peerDependencies: Record<string, string>;
    };
    for (const [name, range] of Object.entries(EXPECTED_PEERS)) {
      assert.equal(sourceManifest.peerDependencies[name], range);
      assert.equal(extracted.packageJson.peerDependencies?.[name], range);
    }
  });
});
