import { writeFile } from "node:fs/promises";
import { activationTraceRecordSchema } from "../src/activation-trace.ts";

await writeFile(
  new URL("../schemas/activation-trace.schema.json", import.meta.url),
  `${JSON.stringify(activationTraceRecordSchema, null, 2)}\n`,
);
