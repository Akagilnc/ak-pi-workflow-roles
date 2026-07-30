- **P1 — Fixer help omits required `apply` obligations.**  
  **Evidence:** `src/role-runtime.ts:240-243` describes apply only as `"execute the approved plan"`, omitting verification and committing repaired work.  
  **Requirement:** “Callers discover the flag, its complete value set, and each value's meaning from `pi --ak-role fixer --help`”; “`apply` means execute an approved plan, **verify, and commit when repaired**.”  
  **Consequence:** Independently installed callers relying on CLI help can invoke or approve an apply phase without expecting verification or a forward commit.  
  **Repair:** Expand the flag description to state: apply executes the approved plan, verifies the repair, and creates a forward commit when repaired.
