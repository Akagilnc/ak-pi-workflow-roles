import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createGitCliTransportV1, createGhJsonTransportV1 } from "./assisted-acquisition.js";
import { createAssistedInvocationTransportV1 } from "./assisted-invocation-transport.js";
import { endAssistedRunV1, enterAssistedCallV1, readAssistedRunV1, recoverAssistedInvocationV1, resumeAssistedCallV1 } from "./assisted-runner.js";
function value(args, name, required = true) {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : void 0;
  if (i >= 0 && (!v || v.startsWith("-")) || required && !v) throw new Error(`missing ${name}`);
  return v;
}
function common() {
  return { git: createGitCliTransportV1(), github: createGhJsonTransportV1(), invocation: createAssistedInvocationTransportV1(), async resolveEnvironmentPolicy() {
    const path = process.env.AK_ASSISTED_ENVIRONMENT_POLICY_FILE;
    if (!path) throw new Error("recovery environment reference unavailable");
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } };
}
const HELP = `ak-assisted-run
  enter --config <assisted-call-v1.json> -- <pi argv>
  resume --config <assisted-call-v1.json> -- <pi argv>
  recover --repository-root <root> --run-id <uuidv7> --invocation-id <uuidv7> --confirmed-stopped
  end --repository-root <root> --run-id <uuidv7>
  status --repository-root <root> --run-id <uuidv7> [--call-id <uuidv7>] --json
`;
async function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--"), assistedArgs = separator < 0 ? argv : argv.slice(0, separator);
  if (assistedArgs.includes("--help") || assistedArgs.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = argv[0];
  if (!command || !["enter", "resume", "recover", "end", "status"].includes(command)) throw new Error("usage: ak-assisted-run enter|resume|recover|end|status ...");
  if (command === "enter" || command === "resume") {
    const split = argv.indexOf("--");
    if (split < 0 || split === argv.length - 1) throw new Error("exactly one Pi argv is required after --");
    const before = argv.slice(1, split);
    if (before.length !== 2 || before[0] !== "--config") throw new Error("usage: enter|resume --config <file> -- <pi argv>");
    const configPath = value(before, "--config");
    const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
    const result2 = command === "enter" ? await enterAssistedCallV1(config, argv.slice(split + 1), common()) : await resumeAssistedCallV1(config, argv.slice(split + 1), common());
    process.stderr.write(`Assisted call ${result2.status}; inspect status --json for the authoritative result.
`);
    return result2.status === "infrastructure_failure" ? 1 : 0;
  }
  const rootValue = value(argv, "--repository-root");
  if (!isAbsolute(rootValue) || resolve(rootValue) !== rootValue) throw new Error("invalid assisted run locator");
  const root = rootValue, runId = value(argv, "--run-id");
  if (command === "status") {
    if (!argv.includes("--json")) throw new Error("status requires --json");
    const result2 = await readAssistedRunV1(root, runId, void 0, value(argv, "--call-id", false));
    process.stdout.write(`${JSON.stringify(result2)}
`);
    return 0;
  }
  if (command === "end") {
    const result2 = await endAssistedRunV1(root, runId);
    process.stdout.write(`${JSON.stringify(result2)}
`);
    return 0;
  }
  const invocationId = value(argv, "--invocation-id");
  if (!argv.includes("--confirmed-stopped")) throw new Error("recover requires --confirmed-stopped");
  const result = await recoverAssistedInvocationV1(root, runId, invocationId, true, common());
  process.stdout.write(`${JSON.stringify(result)}
`);
  return 0;
}
export {
  main
};
