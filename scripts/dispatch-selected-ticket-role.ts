#!/usr/bin/env node
/**
 * Internal machine launcher entry (not a public bin; ADR 0052).
 *
 * The selecting machine already holds a board-selected ticket identity. This
 * entry materializes the typed ticket face (YAML frontmatter ticketNumber) as
 * an ordinary attachment and starts public `ak-role` with `--attach`. No
 * lease/claim/sidecar channel — admission reads the frozen typed field.
 *
 * Usage:
 *   npx tsx scripts/dispatch-selected-ticket-role.ts <ticketNumber> \
 *     [--project <site>] [--home <processHome>] -- <ak-role-args...>
 *
 * Example:
 *   npx tsx scripts/dispatch-selected-ticket-role.ts 176 --project /site -- \
 *     judge --project /site "Review the plan."
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage(): never {
  console.error(`Usage: npx tsx scripts/dispatch-selected-ticket-role.ts <ticketNumber> [--project <site>] [--home <processHome>] -- <ak-role-args...>
  <ticketNumber>  board snapshot issue number already selected by the machine
  --project       site identity / ak-role project root (default: cwd)
  --home          process home forwarded to the child env as HOME when set
  --              end of launcher flags; remaining argv is forwarded to ak-role
`);
  process.exit(2);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Insert `--attach <path>` after the role token (first non-flag arg). */
function injectAttachArg(akRoleArgs: readonly string[], ticketPath: string): string[] {
  const out = [...akRoleArgs];
  // Find first positional token (role name) — skip leading global flags like --model.
  let insertAt = 0;
  while (insertAt < out.length) {
    const token = out[insertAt]!;
    if (token === "--") {
      insertAt += 1;
      break;
    }
    if (token.startsWith("-")) {
      // Skip flag and its value when not --flag=value form and next is not a flag.
      if (!token.includes("=") && insertAt + 1 < out.length && !out[insertAt + 1]!.startsWith("-")) {
        insertAt += 2;
      } else {
        insertAt += 1;
      }
      continue;
    }
    // Landed on role token; attach immediately after it.
    insertAt += 1;
    break;
  }
  out.splice(insertAt, 0, "--attach", ticketPath);
  return out;
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) usage();
const launcherArgv = argv.slice(0, sep);
const akRoleArgs = argv.slice(sep + 1);
if (akRoleArgs.length === 0) usage();

const ticketRaw = launcherArgv[0];
if (ticketRaw === undefined || ticketRaw.startsWith("-")) usage();
const ticketNumber = Number(ticketRaw);
if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
  console.error("ticketNumber must be a positive integer");
  process.exit(2);
}

function flag(name: string): string | undefined {
  const idx = launcherArgv.indexOf(name);
  if (idx < 0) return undefined;
  return launcherArgv[idx + 1];
}

const projectRaw = flag("--project");
const homeRaw = flag("--home");
const siteIdentity = resolve(projectRaw ?? process.cwd());

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultAkRole = resolve(packageRoot, "dist/public-cli/main.js");
const akRolePath = process.env.AK_ROLE_PATH?.trim() || defaultAkRole;

// Prefer PATH-resolved ak-role when present so installed seats match production.
const pathResolved = spawnSync("sh", ["-c", "command -v ak-role"], {
  encoding: "utf8",
  env: process.env,
});
const resolvedAkRole =
  pathResolved.status === 0 && pathResolved.stdout.trim().length > 0
    ? pathResolved.stdout.trim()
    : akRolePath;

// Typed ticket face — ordinary attachment bytes; admission reads frontmatter only.
const ticketDir = mkdtempSync(join(tmpdir(), "ak-ticket-face-"));
const ticketPath = join(ticketDir, `ticket-${ticketNumber}.md`);
writeFileSync(
  ticketPath,
  `---\nticketNumber: ${ticketNumber}\n---\n# #${ticketNumber}\n`,
  "utf8",
);

const childArgs = injectAttachArg(akRoleArgs, ticketPath);
const childEnv = { ...process.env };
if (homeRaw !== undefined) {
  childEnv.HOME = homeRaw;
}

try {
  const result = spawnSync(resolvedAkRole, childArgs, {
    cwd: siteIdentity,
    env: childEnv,
    encoding: "utf8",
    input: "",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if ((result.stdout ?? "").length > 0) process.stdout.write(result.stdout);
  if ((result.stderr ?? "").length > 0) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(formatError(error));
  process.exit(1);
}
