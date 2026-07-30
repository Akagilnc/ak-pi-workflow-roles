- **P2 — CLI help still omits part of the `plan` phase meaning.**  
  **Evidence:** `src/role-runtime.ts:240-243` describes plan as merely “plan only; no edits or commits”; `test/package-entrypoint.integration.test.ts:87-90` locks in that incomplete wording.  
  **Requirement:** “`plan` means **inspect and propose a repair plan** without edits/commit” and callers must discover “each value’s meaning” from help.  
  **Consequence:** A standalone caller cannot learn from the mandated help surface that planning requires inspecting the repository and proposing a repair plan; it may request or accept a speculative packet restatement.  
  **Repair:** Change the flag description and assertion to say, e.g., `plan (inspect and propose a repair plan; no edits or commits)`.

- **P2 — CONTEXT describes a binding gate that the owner explicitly deferred.**  
  **Evidence:** `CONTEXT.md:12` says per-invocation bindings such as Judge target head “fail-closed” when present, while no binding input or gate exists.  
  **Requirement:** “targetHead binding is deferred until a real caller exists; **do not build a dead binding gate now**.”  
  **Consequence:** Git-installed package consumers may infer that supplying a target-head binding is currently supported and mechanically enforced, creating false confidence in receipt validation.  
  **Repair:** Mark binding as a deferred/future concept and explicitly state that this package currently exposes no targetHead binding or fail-closed gate.
