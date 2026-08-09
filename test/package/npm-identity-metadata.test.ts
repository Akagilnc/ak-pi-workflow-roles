import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import {
  getSharedIsolatedPack,
  installPackedArtifactIntoPiNpm,
  packageRoot,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);

async function npmTreeJson(root: string, home: string, packageName: string): Promise<{ dependencies?: Record<string, unknown> }> {
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(
      "npm",
      ["ls", packageName, "--all", "--json"],
      {
        cwd: root,
        env: { ...process.env, HOME: home },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, output) => {
        // npm may report an unrelated file-spec root as ELSPROBLEMS while still
        // returning its complete machine tree. Only that documented status is parseable here.
        if (error && error.code !== 1) reject(error);
        else resolveOutput(output);
      },
    );
  });
  return JSON.parse(stdout) as { dependencies?: Record<string, unknown> };
}

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
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  typebox: "*",
} as const;

interface PiNpmRootManifest {
  dependencies?: Record<string, string>;
}

interface PiNpmRootLockfile {
  packages: Record<string, object>;
}

interface ExtractedPack {
  root: string;
  packageJson: {
    name: string;
    license?: string;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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
      upstream: {
        repository: string;
        path: string;
        commit: string;
        tag: string;
        attribution: string;
        license: string;
      };
      files: Record<
        string,
        { sha256: string; byteLength: number; gitBlob: string }
      >;
    };
    assert.equal(provenance.name, "tdd");
    assert.equal(
      provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(provenance.upstream.path, "skills/engineering/tdd");
    assert.equal(
      provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(provenance.upstream.tag, "v1.2.2");
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
    assert.equal(typeof provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(provenance.files["SKILL.md"]!.sha256.length, 64);
    assert.equal(typeof provenance.files["SKILL.md"]?.gitBlob, "string");
    assert.equal(provenance.files["SKILL.md"]!.gitBlob.length, 40);
    assert.equal(typeof provenance.files["tests.md"]?.sha256, "string");
    assert.equal(typeof provenance.files["tests.md"]?.gitBlob, "string");
    assert.equal(typeof provenance.files["mocking.md"]?.sha256, "string");
    assert.equal(typeof provenance.files["mocking.md"]?.gitBlob, "string");
  });
});

test("packed artifact ships package-owned code-review method with adapted no-setup two-axis boundary", async () => {
  await withExtractedPack(async (extracted) => {
    const required = [
      "resources/methods/code-review/SKILL.md",
      "resources/methods/code-review/agents/openai.yaml",
      "resources/methods/code-review/provenance.json",
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
        resolve(
          extracted.root,
          "package/resources/methods/code-review/provenance.json",
        ),
        "utf8",
      ),
    ) as {
      name: string;
      packageAdaptation: string;
      upstream: {
        repository: string;
        path: string;
        commit: string;
        tag: string;
        attribution: string;
        license: string;
      };
      files: Record<
        string,
        { sha256: string; byteLength: number; gitBlob: string }
      >;
    };
    assert.equal(provenance.name, "code-review");
    assert.equal(
      provenance.packageAdaptation,
      "reviewer-no-setup-fixed-target-two-axis",
    );
    assert.equal(
      provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(
      provenance.upstream.path,
      "skills/engineering/code-review",
    );
    assert.equal(
      provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(provenance.upstream.tag, "v1.2.2");
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
    assert.equal(typeof provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(provenance.files["SKILL.md"]!.sha256.length, 64);
    assert.equal(typeof provenance.files["agents/openai.yaml"]?.gitBlob, "string");
    const skill = await readFile(
      resolve(extracted.root, "package/resources/methods/code-review/SKILL.md"),
      "utf8",
    );
    assert.equal(skill.includes("Do **not** run `/setup-matt-pocock-skills`"), true);
    assert.equal(skill.includes("must **not** modify project governance"), true);
    assert.equal(skill.includes("scratch probes"), true);
    assert.equal(skill.includes("never turn the review into product repairs"), true);
  });
});

test("packed artifact ships package-owned diagnosing-bugs method with adapted boundary", async () => {
  await withExtractedPack(async (extracted) => {
    const required = [
      "resources/methods/diagnosing-bugs/SKILL.md",
      "resources/methods/diagnosing-bugs/agents/openai.yaml",
      "resources/methods/diagnosing-bugs/scripts/hitl-loop.template.sh",
      "resources/methods/diagnosing-bugs/provenance.json",
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
        resolve(
          extracted.root,
          "package/resources/methods/diagnosing-bugs/provenance.json",
        ),
        "utf8",
      ),
    ) as {
      name: string;
      packageAdaptation: string;
      upstream: {
        repository: string;
        path: string;
        commit: string;
        tag: string;
        attribution: string;
        license: string;
      };
      files: Record<
        string,
        { sha256: string; byteLength: number; gitBlob: string }
      >;
    };
    assert.equal(provenance.name, "diagnosing-bugs");
    assert.equal(
      provenance.packageAdaptation,
      "fixer-boundary-no-external-skill-chain",
    );
    assert.equal(
      provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(
      provenance.upstream.path,
      "skills/engineering/diagnosing-bugs",
    );
    assert.equal(
      provenance.upstream.commit,
      "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
    );
    assert.equal(provenance.upstream.tag, "v1.2.2");
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
    assert.equal(typeof provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(provenance.files["SKILL.md"]!.sha256.length, 64);
    assert.equal(typeof provenance.files["agents/openai.yaml"]?.gitBlob, "string");
    assert.equal(
      typeof provenance.files["scripts/hitl-loop.template.sh"]?.gitBlob,
      "string",
    );
    const skill = await readFile(
      resolve(extracted.root, "package/resources/methods/diagnosing-bugs/SKILL.md"),
      "utf8",
    );
    assert.equal(skill.includes("hand off to the `/improve-codebase-architecture`"), false);
    assert.equal(skill.includes("Do **not** launch"), true);
  });
});

test("packed compliance transport has no Pi AI runtime import", async () => {
  await withExtractedPack(async ({ root }) => {
    const complianceJs = await readFile(
      resolve(root, "package/dist/compliance-transport.js"),
      "utf8",
    );
    assert.equal(complianceJs.includes("@earendil-works/pi-ai"), false);
  });
});

test("packed artifact name is the registry-settled identity", async () => {
  await withExtractedPack(async (extracted) => {
    assert.equal(extracted.packageJson.name, SETTLED_PACKAGE_NAME);
  });
});

test("packed Pi core peers follow the host-supplied wildcard optional contract", async () => {
  await withExtractedPack(async (extracted) => {
    const peers = extracted.packageJson.peerDependencies;
    const meta = extracted.packageJson.peerDependenciesMeta;
    assert.ok(peers, "packed package.json must declare peerDependencies");
    assert.ok(meta, "packed package.json must declare peerDependenciesMeta");
    for (const [name, range] of Object.entries(EXPECTED_PEERS)) {
      assert.equal(peers[name], range, `${name} must use the official host range`);
      assert.equal(meta[name]?.optional, true, `${name} must be optional`);
    }

    const sourceManifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as ExtractedPack["packageJson"];
    for (const [name, range] of Object.entries(EXPECTED_PEERS)) {
      assert.equal(sourceManifest.peerDependencies?.[name], range);
      assert.equal(sourceManifest.peerDependenciesMeta?.[name]?.optional, true);
      assert.equal(extracted.packageJson.peerDependencies?.[name], range);
    }
  });
});

test("real Pi fresh install leaves optional host peers uninstalled", async () => {
  await withHermeticHome(
    { prefix: "ak-optional-host-peers-" },
    async ({ home, agentDir }) => {
      const installation = await installPackedArtifactIntoPiNpm(agentDir, home);
      await access(installation.installedRoot);

      const npmRootManifest = JSON.parse(
        await readFile(resolve(installation.npmRoot, "package.json"), "utf8"),
      ) as PiNpmRootManifest;
      assert.deepEqual(
        Object.keys(npmRootManifest.dependencies ?? {}).sort(),
        [SETTLED_PACKAGE_NAME],
        "Pi's npm root must directly depend on only the installed role package",
      );

      const npmRootLockfile = JSON.parse(
        await readFile(resolve(installation.npmRoot, "package-lock.json"), "utf8"),
      ) as PiNpmRootLockfile;
      const installedPackageKeys = Object.keys(npmRootLockfile.packages)
        .filter((key) => key !== "");
      assert.equal(
        installedPackageKeys.length,
        1,
        "Pi's lockfile must contain exactly one installed package",
      );
      assert.equal(
        installedPackageKeys[0]!.endsWith(`node_modules/${SETTLED_PACKAGE_NAME}`),
        true,
        "Pi's sole locked package must be the installed role package",
      );

      for (const hostPeer of Object.keys(EXPECTED_PEERS)) {
        await assert.rejects(
          access(resolve(installation.installedRoot, "node_modules", hostPeer)),
          { code: "ENOENT" },
          `${hostPeer} must not be role-owned`,
        );
      }

      for (const hostPeer of Object.keys(EXPECTED_PEERS)) {
        const tree = await npmTreeJson(installation.npmRoot, home, hostPeer);
        assert.deepEqual(tree.dependencies ?? {}, {}, `${hostPeer} must be absent from Pi's npm tree`);
      }
    },
  );
});
