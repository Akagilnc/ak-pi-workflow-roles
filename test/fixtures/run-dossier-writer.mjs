// Child process for the run-dossier concurrency test: writes one section N times.
import { writeSectionSync } from "../../src/run-dossier.ts";

const [runDirectory, section, tag, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  writeSectionSync(runDirectory, section, { [tag]: i });
}
