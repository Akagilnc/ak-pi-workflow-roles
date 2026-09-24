/**
 * Durable work subject and controlling authority for one navigator nest.
 * Settlement user turns keep a path pointer; the navigator system prompt
 * loads the bytes once per agent start from this file (base material).
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";

export const NAVIGATOR_WORK_CONTEXT_BASENAME = "work-context.json";

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
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
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
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.subject !== "string" || typeof record.authority !== "string") return undefined;
  if (record.authority.trim() === "") return undefined;
  return { subject: record.subject, authority: record.authority };
}

function jsonObjectFromPrompt(prompt: string): Record<string, unknown> | undefined {
  const head = prompt.trimStart().split("\n\n", 1)[0] ?? "";
  if (!head.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(head);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function workContextPathFromPrompt(prompt: string): string | undefined {
  const record = jsonObjectFromPrompt(prompt);
  const path = record?.workContextPath;
  if (typeof path !== "string" || path.trim() === "") return undefined;
  return isNavigatorWorkContextFile(path) ? path : undefined;
}

/** Settlement JSON gains the nest pointer. Non-JSON prompts stay unchanged. */
export function attachWorkContextPointer(text: string, workContextPath: string): string {
  const record = jsonObjectFromPrompt(text);
  if (record === undefined) return text;
  if (typeof record.workContextPath === "string" && record.workContextPath.trim() !== "") return text;
  const head = text.trimStart().split("\n\n", 1)[0] ?? "";
  const rest = text.trimStart().slice(head.length);
  return `${JSON.stringify({ ...record, workContextPath })}${rest}`;
}

/** System-prompt base for one agent start. Absent or unreadable file yields undefined. */
export async function loadNavigatorWorkBaseSuffix(prompt: string): Promise<string | undefined> {
  const path = workContextPathFromPrompt(prompt);
  if (path === undefined) return undefined;
  const body = await readNavigatorWorkBase(path);
  if (body === undefined) return undefined;
  return `<work_subject>\n${body.subject}\n</work_subject>\n\n<controlling_authority>\n${body.authority}\n</controlling_authority>`;
}
