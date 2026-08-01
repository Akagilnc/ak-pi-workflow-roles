#!/usr/bin/env node
import { main } from "../dist/assisted-cli.js";
main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
