import { readFile } from "node:fs/promises";

import { sha256Hex } from "./sha256.ts";
import { isRecord } from "./unknown-value.ts";
import { isTicketNumberString, parseTicketNumber } from "./run-ticket-number.ts";

export const COLLECTOR_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const COLLECTOR_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

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
  if (typeof raw !== "string" && typeof raw !== "number") fail("Collector pull request number is required");
  const value = parseTicketNumber(raw);
  if (value === undefined) fail(typeof raw === "string" && !isTicketNumberString(raw)
    ? "Collector pull request number must be a positive safe integer string"
    : "Collector pull request number must be a positive safe integer");
  return value;
}

function canonicalManifest(requests: readonly CollectorRequestConfig[]): string {
  return `${JSON.stringify({ requests: requests.map((request) => ({ id: request.id, body: request.requestBody })) })}\n`;
}

export function emptyCollectorManifest(): CollectorManifest {
  const canonicalJson = canonicalManifest([]);
  return { requests: [], canonicalJson, digest: sha256Hex(canonicalJson) };
}

/** Optional request configuration. It names requests, never expected observers. */
export async function loadCollectorManifest(path: string): Promise<CollectorManifest> {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (error) { fail(`Collector request manifest is unreadable at ${path}`, error); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { fail("Collector request manifest must be UTF-8 JSON", error); }
  if (!isRecord(parsed)) fail("Collector request manifest must be an object");
  const rawRequests = parsed.requests ?? [];
  if (!Array.isArray(rawRequests)) fail("Collector request manifest requests must be an array");
  const requests: CollectorRequestConfig[] = [];
  const ids = new Set<string>();
  for (const [index, item] of rawRequests.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 || typeof item.body !== "string" || item.body.trim() === "") fail(`Collector request manifest requests[${index}] is invalid`);
    if (ids.has(item.id)) fail(`Collector request manifest has duplicate request id "${item.id}"`);
    ids.add(item.id);
    requests.push({ id: item.id, requestBody: item.body });
  }
  const canonicalJson = canonicalManifest(requests);
  return { requests, canonicalJson, digest: sha256Hex(canonicalJson), sourcePath: path };
}
