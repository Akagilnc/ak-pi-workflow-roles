# Reviewer receipt

```json
{
  "status": "refused",
  "report": "# Review refused\n\nThe supplied fixed point cannot be established in the pinned reviewed target, so the canonical three-dot review cannot honestly begin.\n\nEvidence from the original target checkout:\n\n- Reviewed target resolves exactly: `HEAD` and `98f36c046d1bcd68cac155868d313c8cf00bc2d1` both resolve to `98f36c046d1bcd68cac155868d313c8cf00bc2d1`.\n- `git cat-file -t 3808c2d15764a48e5852fdac43f429535820419e` fails with `could not get object info`.\n- `git rev-parse --verify '3808c2d15764a48e5852fdac43f429535820419e^{commit}'` fails with `Needed a single revision`.\n- Consequently, both `git log 3808c2d15764a48e5852fdac43f429535820419e..HEAD --oneline` and `git diff 3808c2d15764a48e5852fdac43f429535820419e...HEAD` fail as invalid revision expressions.\n- The actual parent of the reviewed target is a different object: `3808c2dca83417b5e07e4b8f922914435d01be7c`.\n\nThe canonical Skill requires a bad fixed-point ref to fail before spawning the Standards and Spec agents. I therefore did not run either substantive review leg and did not substitute the similarly prefixed parent commit, which would guess a different review authority."
}
```
