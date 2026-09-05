import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entries = [
  "packaged-role-registry",
  "public-command-renderer",
  "work-subject-identity",
  "navigator-invocation-identity",
  // Static import of navigator-invocation-identity (#603: non-bundle graph closure).
  "uuidv7",
  "navigator-attendance",
  // Navigator package-graph dependencies used by attendance settlement.
  // navigator-session-contracts is a static import of the published attendance root
  // (#590: published non-bundle graph must stay closed under its own relative edges).
  "evidence-child-executor",
  "navigator-session-contracts",
  "pi/in-process-session",
  "activation-ledger-git",
  "activation-ledger-topology",
  "activation-reconciliation",
  "archivist-record-entry",
  // Pure subject nest topology — cold discovery without SessionManager (#636).
  "archivist-record-topology",
  // Officer ticket-seat pure read + deferred open (#636 public-bin cold graph).
  "ticket-seat-memory",
  "typed-provider-http",
  "upstream-error-testimony",
];

/**
 * Public ak-role CLI bundle (ADR 0052): one bin, no peer-runtime import required
 * for roles/config/help discovery. package.json#bin → dist/public-cli/main.js.
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

/**
 * Deferred grok-build production host artifact. Loaded only when the composition
 * root selects grok-build — keeps role-runtime / peer edges out of the public bin.
 * packages:"external" so optional peers resolve from the install tree at selection.
 */
export async function buildGrokProductionHost(
  outfile = "dist/grok/production-host.js",
) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: ["src/grok/production-host.ts"],
    outfile,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    packages: "external",
    logLevel: "silent",
  });
  // role-envelope resolves ./mcp-relay.mjs from import.meta.url — keep it beside the bundle.
  await copyFile(
    resolve("src/grok/mcp-relay.mjs"),
    join(dirname(outfile), "mcp-relay.mjs"),
  );
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
  // Rewrite both static `from ".ts"` and dynamic `import(".ts")` so published
  // non-bundle modules never leave unloadable .ts relative edges (#590).
  for (const name of entries) {
    const path = `dist/${name}.js`;
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replaceAll(
        /(from\s*|import\s*\(\s*)(["'])([^"']+)\.ts\2/g,
        "$1$2$3.js$2",
      ),
    );
  }
  await buildPublicAkRoleBin();
  await buildGrokProductionHost();
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  await buildPackageArtifacts();
}
