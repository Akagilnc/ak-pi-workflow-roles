import { chmod, writeFile } from "node:fs/promises";

export { isolatedTestProcessEnv } from "../../scripts/test-process-env.mjs";

export const TEST_PI_VERSION = "test-pi-1.0.0";
export const TEST_PI_VERSION_BRANCH = `if (process.argv[2] === "--version") { console.log(${JSON.stringify(TEST_PI_VERSION)}); process.exit(0); }`;

/** Add the one shared Pi identity response to a fixture-specific executable body. */
export function versionAwarePiShim(source: string): string {
  return source.replace("\n", `\n${TEST_PI_VERSION_BRANCH}\n`);
}

export async function writeVersionAwarePiShim(path: string, source: string): Promise<void> {
  await writeFile(path, versionAwarePiShim(source), "utf8");
  await chmod(path, 0o755);
}
