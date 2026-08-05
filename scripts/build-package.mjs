import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const entries = ["packaged-role-registry", "navigator-attendance", "activation-ledger-topology", "activation-reconciliation"];
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

// Public ak-role CLI (ADR 0052 / #105): one bundled bin, no peer-runtime import required
// for roles/config/help discovery. Role-run dispatch lands in later slices.
await mkdir("dist/public-cli", { recursive: true });
await build({
  entryPoints: ["src/public-cli/main.ts"],
  outfile: "dist/public-cli/main.js",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  logLevel: "silent",
});
await chmod("dist/public-cli/main.js", 0o755);
