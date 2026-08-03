import { writeFile } from "node:fs/promises";
import { toolExecutionObservationRecordSchema } from "../src/tool-execution-observation.ts";

await writeFile(
  new URL("../schemas/tool-execution-observation.schema.json", import.meta.url),
  `${JSON.stringify(toolExecutionObservationRecordSchema, null, 2)}\n`,
);
