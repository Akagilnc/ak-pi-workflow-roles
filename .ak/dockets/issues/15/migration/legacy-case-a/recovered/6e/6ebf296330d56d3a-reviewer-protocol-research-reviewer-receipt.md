## Standards

1. **Hard — `docs/research/external-reviewer-protocols.md:5-7,119-156` places normative contracts in the wrong documentation layer and conflicts with current true sources.**  
   Quotes: “`## Decision summary`”, “`Collector must adapt`”, and the proposed `"protocol"` manifest field / receipt state `pending, completed, unavailable, or missing`. `CONTEXT.md:3` assigns decision rationale to ADRs; `CLAUDE.md` assigns field semantics to schemas, mechanical invariants to runtime, and usage contracts to README. Current `schemas/collector-legs-v1.schema.json:14-38` rejects `"protocol"`, while `README.md:140` and `src/collector-role.ts:124-126` define `valid|unavailable|missing` and explicitly forbid submitting `pending`. The document is therefore presented as a decision while creating a competing, unusable contract.

2. **Hard — `docs/adr/0010-callers-own-role-composition-and-repetition.md:10,14` contradicts the committed Fixer contract.**  
   Quotes: “`可以直接调用 Fixer`” and a repair packet “`不得要求...必须由 Judge 产生`”. But `CONTEXT.md:10` still defines Fixer as processing a “`判官修理包`”, and `README.md:46` says it loads a “`judge-authored Markdown repair packet`”. Because `CLAUDE.md` makes README the owner of caller instructions, the accepted ADR leaves callers with mutually incompatible guidance.

**Baseline smells:** none independently reportable.

## Spec

- **High — Undocumented Codex evidence is made normative** (`docs/research/external-reviewer-protocols.md:41-68`).  
  Spec: **“It must not silently authorize runtime behavior not supported by cited primary sources.”**  
  The cited OpenAI documentation says Codex reacts with 👀 and “posts a standard GitHub code review”; it does not document a `+1` plus issue-comment no-findings protocol. Lines 54-59 correctly label that form as a repository observation, but line 64 then calls it “documented” and recommends accepting it as terminal evidence. PR #5/API fixtures are not linked, so the consequential acceptance rule lacks verifiable primary-source support.

- **Medium — Cursor check output is claimed to disambiguate `neutral` without source support** (`docs/research/external-reviewer-protocols.md:11-15,96-115`).  
  Spec: **“primary-source support for … Cursor Bugbot …; clear distinction between documented contract, observed behavior, recommendation, and future design.”**  
  Cursor documents that `neutral` can mean findings, cancellation, or internal error, but does not document a structured check-output discriminator for those cases or quota failures. Lines 15 and 113-114 nevertheless say output distinguishes them and recommend terminal classification from it. The quota case is only an uncited repository observation.

- **Medium — Future Collector proposals are presented as accepted requirements** (`docs/research/external-reviewer-protocols.md:119-176`).  
  Spec: **“The current change is documentation/research only”** and requires a **“clear distinction between … recommendation, and future design.”**  
  Protocol manifest fields, receipt states, transport capabilities, restart behavior, and fixture obligations are headed “Collector design requirements” and use normative “must/remains,” without an explicit proposed/future/not-implemented status. This blurs owner-approved decisions with unsourced future architecture.

Review probes were read-only; no working-tree changes were made.

Summary: Standards — 2 findings (worst: hard documentation-layer violation creating a competing unusable contract); Spec — 3 findings (worst: high-severity normative acceptance of undocumented Codex evidence).
