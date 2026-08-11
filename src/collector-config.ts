import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const COLLECTOR_HOST = "github.com" as const;
export const COLLECTOR_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const COLLECTOR_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
export const COLLECTOR_FIXED_KICKOFF =
  "Start collection for the validated runtime-owned target. Observe GitHub materials and submit exactly one ak_collector_output when observation is complete.";

export type CollectorRepository = {
  display: string;
  canonical: string;
  owner: string;
  repo: string;
};

export type CollectorRequestConfig = { id: string; requestBody: string };
export type CollectorManifest = {
  requests: readonly CollectorRequestConfig[];
  canonicalJson: string;
  digest: string;
  sourcePath?: string;
};

function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function conservativeAscii(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0x7f) return false;
  }
  return true;
}

export function parseCollectorRepository(raw: unknown): CollectorRepository {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) fail("Collector repository must be a string owner/repo");
  if (!conservativeAscii(raw) || raw.includes("://") || /[?#@%\\ ]/.test(raw)) fail("Collector repository rejects URL syntax and non-identity bytes");
  const parts = raw.split("/");
  if (parts.length !== 2) fail("Collector repository must contain exactly one '/' separating owner and repo");
  const [ownerDisplay, repoDisplay] = parts as [string, string];
  if (!COLLECTOR_OWNER_PATTERN.test(ownerDisplay) || !COLLECTOR_REPO_PATTERN.test(repoDisplay)) fail("Collector repository does not match the conservative owner/repo grammar");
  const owner = ownerDisplay.toLowerCase();
  const repo = repoDisplay.toLowerCase();
  return { display: raw, canonical: `${owner}/${repo}`, owner, repo };
}

export function parseCollectorPrNumber(raw: unknown): number {
  if (typeof raw === "string" && !/^[1-9][0-9]*$/.test(raw)) fail("Collector pull request number must be a positive safe integer string");
  if (typeof raw !== "string" && typeof raw !== "number") fail("Collector pull request number is required");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail("Collector pull request number must be a positive safe integer");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalManifest(requests: readonly CollectorRequestConfig[]): string {
  return `${JSON.stringify({ requests: requests.map((request) => ({ id: request.id, body: request.requestBody })) })}\n`;
}

export function emptyCollectorManifest(): CollectorManifest {
  const canonicalJson = canonicalManifest([]);
  return { requests: [], canonicalJson, digest: createHash("sha256").update(canonicalJson).digest("hex") };
}

/** Optional request configuration. It names requests, never expected observers. */
export async function loadCollectorManifest(path: string): Promise<CollectorManifest> {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (error) { fail(`Collector request manifest is unreadable at ${path}`, error); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { fail("Collector request manifest must be UTF-8 JSON", error); }
  if (!record(parsed)) fail("Collector request manifest must be an object");
  const rawRequests = parsed.requests ?? [];
  if (!Array.isArray(rawRequests)) fail("Collector request manifest requests must be an array");
  const requests: CollectorRequestConfig[] = [];
  const ids = new Set<string>();
  for (const [index, item] of rawRequests.entries()) {
    if (!record(item) || typeof item.id !== "string" || item.id.length === 0 || typeof item.body !== "string" || item.body.trim() === "") fail(`Collector request manifest requests[${index}] is invalid`);
    if (ids.has(item.id)) fail(`Collector request manifest has duplicate request id "${item.id}"`);
    ids.add(item.id);
    requests.push({ id: item.id, requestBody: item.body });
  }
  const canonicalJson = canonicalManifest(requests);
  return { requests, canonicalJson, digest: createHash("sha256").update(canonicalJson).digest("hex"), sourcePath: path };
}
