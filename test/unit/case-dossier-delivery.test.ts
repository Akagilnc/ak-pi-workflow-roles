/**
 * #742 — countersign-admission-path 起居录 pointer delivery.
 * Bound ticket → path section; unbound → no section. No content locks.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CASE_DOSSIER_SECTION_HEADING,
  deliverCaseDossierPointerToTurn,
  projectCaseDossierPointerSection,
} from "../../src/public-cli/case-dossier-delivery.ts";
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

test("projectCaseDossierPointerSection: unbound yields nothing", async () => {
  const section = await projectCaseDossierPointerSection({
    ticketNumber: undefined,
    projectRoot: "/tmp",
    home: "/tmp",
  });
  assert.equal(section, undefined);
});

test("projectCaseDossierPointerSection: bound ticket states paths honestly", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-dossier-del-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const volume = resolveTicketProvenanceVolume(742, project, home);
  await mkdir(volume.volumeDir, { recursive: true });
  await writeFile(volume.humanViewFile, "# 起居录 · #742\n", "utf8");
  // recordFile absent → "尚未生成"

  const section = await projectCaseDossierPointerSection({
    ticketNumber: 742,
    projectRoot: project,
    home,
  });
  assert.ok(section);
  assert.ok(section!.startsWith(CASE_DOSSIER_SECTION_HEADING));
  assert.ok(section!.includes("票号：#742"));
  assert.ok(section!.includes(volume.humanViewFile));
  assert.ok(section!.includes(`尚未生成：${volume.recordFile}`));
});

test("deliverCaseDossierPointerToTurn appends section onto continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-dossier-del-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  const volume = resolveTicketProvenanceVolume(742, project, home);
  await mkdir(volume.volumeDir, { recursive: true });
  await writeFile(volume.humanViewFile, "# 起居录\n", "utf8");
  await writeFile(volume.recordFile, "{}\n", "utf8");

  const turnRequest = {
    continuation: { kind: "initial" as const, prompt: "裁：本票是否足以开工。" },
  } as RoleTurnRequest;

  await deliverCaseDossierPointerToTurn({
    ticketNumber: 742,
    projectRoot: project,
    home,
    turnRequest,
  });

  assert.equal(turnRequest.continuation.kind, "initial");
  assert.ok(turnRequest.continuation.prompt.startsWith("裁：本票是否足以开工。"));
  assert.ok(turnRequest.continuation.prompt.includes(CASE_DOSSIER_SECTION_HEADING));
  assert.ok(turnRequest.continuation.prompt.includes(volume.humanViewFile));
  assert.ok(turnRequest.continuation.prompt.includes(volume.recordFile));
});
