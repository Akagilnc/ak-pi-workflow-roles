import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  "@earendil-works/pi-ai": ">=0.83.0 <=0.83.0",
  "@earendil-works/pi-coding-agent": ">=0.83.0 <=0.83.0",
  typebox: ">=1.3.7 <=1.3.8",
} as const;

/** Declared TypeBox endpoints that must execute this packed package (docs/npm-identity.md). */
const TYPEBOX_EXECUTABLE_MATRIX = ["1.3.7", "1.3.8"] as const;

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

test("packed artifact ships package-owned tdd method with companions and provenance", async () => {
  await withExtractedPack(async (extracted) => {
    const required = [
      "resources/methods/tdd/SKILL.md",
      "resources/methods/tdd/tests.md",
      "resources/methods/tdd/mocking.md",
      "resources/methods/tdd/agents/openai.yaml",
      "resources/methods/tdd/provenance.json",
    ];
    for (const path of required) {
      assert.ok(
        extracted.paths.includes(path),
        `npm pack must include ${path}`,
      );
      await access(resolve(extracted.root, "package", path));
    }
    const provenance = JSON.parse(
      await readFile(
        resolve(extracted.root, "package/resources/methods/tdd/provenance.json"),
        "utf8",
      ),
    ) as {
      name: string;
      upstream: { repository: string; attribution: string; license: string };
      files: Record<string, { sha256: string; byteLength: number }>;
    };
    assert.equal(provenance.name, "tdd");
    assert.equal(
      provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
    assert.equal(typeof provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(provenance.files["SKILL.md"]!.sha256.length, 64);
    assert.equal(typeof provenance.files["tests.md"]?.sha256, "string");
    assert.equal(typeof provenance.files["mocking.md"]?.sha256, "string");
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

/**
 * Pack one exact typebox pin into the consumer temp tree. Lifecycle is bounded to
 * that consumer directory — no second permanent ready-marker cache beside the
 * harness pack/cold-install owner.
 */
async function packTypeboxPeerTarball(
  destinationDir: string,
  version: (typeof TYPEBOX_EXECUTABLE_MATRIX)[number],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", `typebox@${version}`, "--json", "--pack-destination", destinationDir],
    { cwd: destinationDir, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  const entry = (JSON.parse(stdout) as Array<{ filename: string }>)[0];
  assert.ok(entry?.filename, `npm pack typebox@${version} must emit a tarball`);
  return resolve(destinationDir, entry.filename);
}

function isPackedFixerPacketValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "FixerPacketValidationError" &&
    (error as { code?: unknown }).code === "AK_INVALID_FIX_PACKET"
  );
}

async function withTypeboxMatrixConsumer<
  T,
>(
  typeboxVersion: (typeof TYPEBOX_EXECUTABLE_MATRIX)[number],
  scenario: (paths: {
    consumer: string;
    installedRoot: string;
    typeboxRoot: string;
  }) => Promise<T>,
): Promise<T> {
  const pack = await getSharedIsolatedPack();
  const consumer = await mkdtemp(resolve(tmpdir(), `ak-typebox-matrix-${typeboxVersion}-`));
  return await withPrimaryAwareCleanup(
    async () => {
      const typeboxTarball = await packTypeboxPeerTarball(consumer, typeboxVersion);
      await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: {
            "@akagilnc/pi-workflow-roles": `file:${pack.tarball}`,
            "@earendil-works/pi-ai": `file:${resolve(
              packageRoot,
              "node_modules/@earendil-works/pi-ai",
            )}`,
            "@earendil-works/pi-coding-agent": `file:${resolve(
              packageRoot,
              "node_modules/@earendil-works/pi-coding-agent",
            )}`,
            typebox: `file:${typeboxTarball}`,
          },
        }),
      );
      await execFileAsync(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: consumer, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      );
      const installedRoot = resolve(
        consumer,
        "node_modules/@akagilnc/pi-workflow-roles",
      );
      const typeboxRoot = resolve(consumer, "node_modules/typebox");
      return await scenario({ consumer, installedRoot, typeboxRoot });
    },
    async () => {
      await rm(consumer, { recursive: true, force: true });
    },
  );
}

test("cold-installed package executes against each declared typebox matrix endpoint", async () => {
  for (const typeboxVersion of TYPEBOX_EXECUTABLE_MATRIX) {
    await withTypeboxMatrixConsumer(typeboxVersion, async ({
      consumer,
      installedRoot,
      typeboxRoot,
    }) => {
      const installedTypeboxVersion = JSON.parse(
        await readFile(resolve(typeboxRoot, "package.json"), "utf8"),
      ).version as string;
      assert.equal(
        installedTypeboxVersion,
        typeboxVersion,
        `consumer must resolve top-level typebox ${typeboxVersion}`,
      );

      const modulePath = resolve(
        installedRoot,
        "dist/package-contracts/fixer-packet.js",
      );
      const requireFromPackage = createRequire(modulePath);
      const resolvedTypeboxEntry = await realpath(
        requireFromPackage.resolve("typebox"),
      );
      const canonicalTypeboxRoot = await realpath(typeboxRoot);
      assert.ok(
        resolvedTypeboxEntry === canonicalTypeboxRoot ||
          resolvedTypeboxEntry.startsWith(`${canonicalTypeboxRoot}/`),
        `packed package must load consumer typebox ${typeboxVersion}, not Pi nested copies (resolved ${resolvedTypeboxEntry})`,
      );

      const fixerPacket = await import(pathToFileURL(modulePath).href) as {
        parseFixerPrerequisites: (source: string) => readonly unknown[];
      };
      const accepted = fixerPacket.parseFixerPrerequisites(
        JSON.stringify([{ id: "matrix-ok", requirement: "need matrix proof" }]),
      );
      assert.equal(accepted.length, 1);
      assert.equal(
        (accepted[0] as { id: string }).id,
        "matrix-ok",
        `packed fixer schema must accept under typebox ${typeboxVersion}`,
      );
      assert.throws(
        () =>
          fixerPacket.parseFixerPrerequisites(
            JSON.stringify([{ id: "bad id", requirement: "x" }]),
          ),
        isPackedFixerPacketValidationError,
        `packed fixer schema must reject under typebox ${typeboxVersion}`,
      );

      // Guard against silently using the workspace root typebox via path bleed.
      const canonicalConsumerModules = await realpath(
        resolve(consumer, "node_modules"),
      );
      const workspaceTypebox = await realpath(
        resolve(packageRoot, "node_modules/typebox"),
      ).catch(() => undefined);
      assert.notEqual(canonicalTypeboxRoot, workspaceTypebox);
      assert.ok(
        canonicalTypeboxRoot.startsWith(`${canonicalConsumerModules}/`) ||
          canonicalTypeboxRoot === canonicalConsumerModules,
        "typebox peer must live inside the cold-installed consumer",
      );
    });
  }
});
