import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const TYPED_HTTP_FILE = "typed-provider-http.json";
function typedProviderHttpPath(runDirectory) {
  return join(runDirectory, TYPED_HTTP_FILE);
}
async function clearTypedProviderHttpObservation(runDirectory) {
  try {
    await unlink(typedProviderHttpPath(runDirectory));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
async function recordTypedProviderHttpStatus(runDirectory, observation) {
  if (observation.httpStatus >= 200 && observation.httpStatus < 300) {
    await clearTypedProviderHttpObservation(runDirectory);
    return;
  }
  const body = {
    httpStatus: observation.httpStatus,
    provider: observation.provider
  };
  await writeFile(
    typedProviderHttpPath(runDirectory),
    `${JSON.stringify(body)}
`,
    "utf8"
  );
}
async function readLatestTypedProviderHttpObservation(runDirectory) {
  let text;
  try {
    text = await readFile(typedProviderHttpPath(runDirectory), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return void 0;
    }
    throw error;
  }
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("typed provider HTTP observation must be a JSON object");
  }
  const record = raw;
  if (typeof record.httpStatus !== "number") {
    throw new Error("typed provider HTTP observation missing numeric httpStatus");
  }
  if (typeof record.provider !== "string" || record.provider.trim() === "") {
    throw new Error("typed provider HTTP observation missing non-empty provider");
  }
  return { httpStatus: record.httpStatus, provider: record.provider };
}
export {
  clearTypedProviderHttpObservation,
  readLatestTypedProviderHttpObservation,
  recordTypedProviderHttpStatus
};
