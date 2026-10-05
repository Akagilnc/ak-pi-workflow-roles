/**
 * Durable work subject and controlling authority for one navigator nest.
 * Startup materials load these bytes from the nest session directory; the
 * caller/summon prompt must not receive a package-injected path (#1166).
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import { isEnoent, isRecord } from "./unknown-value.ts";

export const NAVIGATOR_WORK_CONTEXT_BASENAME = "work-context.json";

/** Child-process / in-process locator for nest work-context bytes — not prompt material (#1166). */
export const AK_ROLE_NAVIGATOR_WORK_CONTEXT_ENV = "AK_ROLE_NAVIGATOR_WORK_CONTEXT" as const;

export type NavigatorWorkBase = {
  readonly subject: string;
  readonly authority: string;
};

export function navigatorWorkContextFile(sessionDir: string): string {
  return join(sessionDir, NAVIGATOR_WORK_CONTEXT_BASENAME);
}

/** Nest file only: books/.../navigator/<sha256-32>/work-context.json. */
export function isNavigatorWorkContextFile(path: string): boolean {
  const resolved = resolve(path);
  if (basename(resolved) !== NAVIGATOR_WORK_CONTEXT_BASENAME) return false;
  const nest = dirname(resolved);
  if (!/^[0-9a-f]{32}$/.test(basename(nest))) return false;
  return basename(dirname(nest)) === "navigator";
}

function canonicalNavigatorWorkContextFile(path: string): string | undefined {
  if (!isNavigatorWorkContextFile(path)) return undefined;
  try {
    const real = realpathSync(path);
    return isNavigatorWorkContextFile(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

export async function persistNavigatorWorkBase(
  sessionDir: string,
  body: NavigatorWorkBase,
): Promise<string | undefined> {
  if (sessionDir.trim() === "" || !existsSync(sessionDir)) return undefined;
  if (body.authority.trim() === "") return undefined;
  const path = navigatorWorkContextFile(sessionDir);
  const next = `${JSON.stringify({ subject: body.subject, authority: body.authority })}\n`;
  try {
    const current = await readFile(path, "utf8");
    if (current === next) return path;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  await writeFileAtomically(path, next);
  return path;
}

export async function readNavigatorWorkBase(path: string): Promise<NavigatorWorkBase | undefined> {
  const canonical = canonicalNavigatorWorkContextFile(path);
  if (canonical === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(canonical, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.subject !== "string" || typeof record.authority !== "string") return undefined;
  if (record.authority.trim() === "") return undefined;
  return { subject: record.subject, authority: record.authority };
}

/** System-prompt base for one agent start. Prefer internal env locator, else nest session dir. */
export async function loadNavigatorWorkBaseSuffix(
  sessionDir: string | undefined,
): Promise<string | undefined> {
  const fromEnv = process.env[AK_ROLE_NAVIGATOR_WORK_CONTEXT_ENV];
  const path =
    typeof fromEnv === "string" && fromEnv.trim() !== ""
      ? fromEnv.trim()
      : sessionDir !== undefined && sessionDir.trim() !== ""
        ? navigatorWorkContextFile(sessionDir)
        : undefined;
  if (path === undefined) return undefined;
  const body = await readNavigatorWorkBase(path);
  if (body === undefined) return undefined;
  return `<work_subject>\n${body.subject}\n</work_subject>\n\n<controlling_authority>\n${body.authority}\n</controlling_authority>`;
}
