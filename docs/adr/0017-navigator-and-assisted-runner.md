# 0017 — Navigator advises; Assisted Runner attends

Status: accepted (Issue #28 authority)

## Decision

Navigator is a distinct advisory role over one caller-declared parent subject and exact registered child universe. It receives a frozen canonical snapshot and bounded sealed evidence, returns one typed primary posture, and is audited by a fresh call to the same active model. Its receipt binds the run, immutable subject, child universe through the snapshot digest, position cursor, latest settled attempt, invocation, and evidence-read record. Capture time alone does not alter the decision digest.

Navigator has no operational tools and does not adjudicate correctness, authorize work, invoke roles, or mutate anything. Ordinary, insufficient, refused, and escalated are distinct professional dispositions; validation, acquisition, audit, model, tool, and transport failures remain infrastructure failures without a manufactured receipt.

Assisted Runner owns consultation attendance and durable run truth. Each enter/resume call wraps exactly one caller-selected packaged non-Navigator role. It consults before launch, reacquires immediately before launch, records followed/deviated without enforcing advice, settles that one role through Recorder, advances the position cursor, consults again, and returns. It never chooses another role or continues a workflow.

The canonical append-only hash chain lives at `.ak/work/issues/<parent>/assisted/<runId>/`. `callId` is idempotency identity; each physical role or Navigator invocation has a distinct UUIDv7. Atomic create-if-absent generations reject concurrent writers, gaps, forks, digest changes, and conflicting settlements. A started invocation without a Recorder docket is never respawned; confirmed recovery records an infrastructure classification. End means assisted mode ended only.

Typed Git/GitHub adapters acquire only the caller-declared repository, parent, children, workspaces, evidence, and label policy universe. No prose, filenames, labels, branches, comments, or logs establish membership or routing. Credentials, raw API responses, environment values, passthrough streams, and raw sessions remain outside promoted snapshot evidence.

## Responsibility boundaries

- Navigator: professional next-process advice only.
- Assisted Runner: run identity, acquisition, attendance/binding gate, one supplied invocation, ledger/recovery/end.
- Recorder: one invocation's session/receipt/audit sealing only.
- Existing roles: unchanged direct single-invocation semantics.
- Caller: every selected role/phase/argv/cwd, worktree and external action, declarations, retries/budget, and assisted-mode exit.

## Consequences

ADR 0010 is narrowed only for Navigator advice and Runner's automatic consultations. Direct role invocation remains compatible. The package gains no queue, scheduler, station graph, worktree manager, or compulsory route policy.

**Forward amendment (2026-08-02):** Assisted Runner now owns only a private direct adapter that launches its one caller-selected Pi child, reads that invocation’s Pi-native session, and keeps derived settlement material local to the Assisted run. The global Recorder and its sealing/manifest contracts are retired; no general replacement is implied.
