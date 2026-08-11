import { chmod, writeFile } from "node:fs/promises";

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

/** Never let a test-owned process inherit a live role ledger or machine Pi home. */
export function isolatedTestProcessEnv(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  agentDir?: string;
} = {}): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  delete env.AK_ROLE_RUN_DIR;
  delete env.PI_CODING_AGENT_DIR;
  if (options.home !== undefined) env.HOME = options.home;
  if (options.agentDir !== undefined) env.PI_CODING_AGENT_DIR = options.agentDir;
  return env;
}
