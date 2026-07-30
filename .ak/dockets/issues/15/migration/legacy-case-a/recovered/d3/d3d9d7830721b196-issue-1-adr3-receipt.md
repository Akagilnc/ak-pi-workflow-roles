# Issue #1 ADR residual receipt

```json
{
  "status": "completed",
  "report": "## Applied\n\nOne-sentence docs fix in `docs/adr/0003-per-role-submission-tools.md` only.\n\n**Root cause:** HEAD `e974c3c` set header `Status: accepted` but left the ADR 0010 supersession note claiming the remainder retained `proposed`.\n\n**Change:** Final supersession sentence only:\n- before: `The rest of this ADR remains under its existing \\`proposed\\` status.`\n- after: `The rest of this ADR remains \\`accepted\\`, subject to ADR 0010's explicit supersession.`\n\n**Preserved (byte-for-byte elsewhere):** header `Status: accepted`; caller-owned advisory commit-evidence wording; rejection of mandatory Judge authorship / next-hop routing; no runtime/schema/Soul/other ADR edits.\n\n## Verification\n\n- One-file diff: `docs/adr/0003-per-role-submission-tools.md` (+1/−1)\n- `rg` on ADR 0003: `accepted` present; no `proposed`\n- Preserved terms still present: `caller`, `advisory`, `Judge authorship`, `next-hop`\n- Clean worktree after commit\n- HEAD is strict forward descendant of start `e974c3c`\n\n## Commit\n\n`d671e4f6f093a710009223105f13cddff7fbbcd7` — `docs(adr): align ADR 0003 supersession remainder with accepted status`",
  "commitSha": "d671e4f6f093a710009223105f13cddff7fbbcd7"
}
```
