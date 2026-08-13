/**
 * Shared durable typed-provider HTTP observation owner.
 * Published with both public-cli and navigator-attendance entries.
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TYPED_HTTP_FILE = "typed-provider-http.json";

export type TypedProviderHttpObservation = {
  readonly httpStatus: number;
  readonly provider: string;
};

function typedProviderHttpPath(runDirectory: string): string {
  return join(runDirectory, TYPED_HTTP_FILE);
}

/**
 * Clear any prior attempt's typed provider HTTP observation.
 * Each initial/resume dispatch must start without inherited 429 evidence so
 * only the current attempt can qualify v1 resume.
 */
export async function clearTypedProviderHttpObservation(
  runDirectory: string,
): Promise<void> {
  try {
    await unlink(typedProviderHttpPath(runDirectory));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Record a typed provider HTTP status observation for the admitted run.
 * Only non-success HTTP statuses are persisted (authorized error evidence).
 * A 2xx response clears any prior observation so success cannot leave stale
 * error evidence. Never inspects diagnostic prose.
 */
export async function recordTypedProviderHttpStatus(
  runDirectory: string,
  observation: { readonly httpStatus: number; readonly provider: string },
): Promise<void> {
  if (observation.httpStatus >= 200 && observation.httpStatus < 300) {
    await clearTypedProviderHttpObservation(runDirectory);
    return;
  }
  const body: TypedProviderHttpObservation = {
    httpStatus: observation.httpStatus,
    provider: observation.provider,
  };
  await writeFile(
    typedProviderHttpPath(runDirectory),
    `${JSON.stringify(body)}\n`,
    "utf8",
  );
}

/**
 * Read the latest durable typed provider HTTP observation, if any.
 * Returns undefined unless both httpStatus and provider are present as typed fields.
 */
export async function readLatestTypedProviderHttpObservation(
  runDirectory: string,
): Promise<TypedProviderHttpObservation | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(typedProviderHttpPath(runDirectory), "utf8"),
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.httpStatus !== "number") return undefined;
    if (typeof record.provider !== "string" || record.provider.trim() === "") {
      return undefined;
    }
    return { httpStatus: record.httpStatus, provider: record.provider };
  } catch {
    return undefined;
  }
}
