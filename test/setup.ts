import { rm } from "node:fs/promises";
import { afterAll } from "vitest";

// Isolation is applied once by the worker preload; this hook owns teardown.
const home = process.env.AK_TEST_USER_PROFILE_HOME!;
// Fork teardown may terminate the process without Node's exit event.
afterAll(() => rm(home, { recursive: true, force: true }));
