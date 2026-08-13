import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entries = [
  "packaged-role-registry",
  "public-command-renderer",
  "work-subject-identity",
  "navigator-invocation-identity",
  "navigator-attendance",
  "activation-ledger-git",
  "activation-ledger-topology",
  "activation-reconciliation",
  "sitian-role-run-coordinates",
  "sitian-record-entry",
];

/**
 * Public ak-role CLI bundle (ADR 0052): one bin, no peer-runtime import required
 * for roles/config/help discovery. package.json#bin → dist/public-cli/main.js.
 * Exported so package tests can prove the committed artifact matches source.
 */
export async function buildPublicAkRoleBin(
  outfile = "dist/public-cli/main.js",
) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: ["src/public-cli/main.ts"],
    outfile,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    banner: {
      js: "#!/usr/bin/env node\n",
    },
    logLevel: "silent",
  });
  await chmod(outfile, 0o755);
}

export async function buildPackageArtifacts() {
  await build({
    entryPoints: entries.map((name) => `src/${name}.ts`),
    outdir: "dist",
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: false,
    packages: "external",
  });
  for (const name of entries) {
    const path = `dist/${name}.js`;
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replaceAll(/(from\s*["'][^"']+)\.ts(["'])/g, "$1.js$2"));
  }
  await buildPublicAkRoleBin();
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  await buildPackageArtifacts();
}
