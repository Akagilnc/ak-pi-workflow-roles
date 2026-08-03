# 0011 — Collector adapts to documented reviewer protocols

Status: accepted（陛下 2026-07-28 拍定）
Date: 2026-07-28

## Decision

Collector should adapt to each reviewer’s **documented** completion forms rather than require every leg to emit a GitHub `PullRequestReview`.

## Consequences

- No protocol profiles, manifest `protocol` field, expanded transport surfaces, or expanded submitted statuses ship with this acceptance.
- Current v1 may remain review-shaped; that shape is an implementation fact, not a permanent universal rule.
- Undocumented repository observations are not terminal authority without first-party support **and** captured fixtures.
- Detailed provider observations, future profile sketches, and design matrices live in research notes and are not package law.

## Non-goals

This ADR does not define JSON examples, profile names, multi-state operation models beyond current v1, or reactions/checks/statuses as Collector transport.
