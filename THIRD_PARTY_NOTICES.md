# Third-Party Notices

This project (`@akagilnc/pi-workflow-roles`) is licensed under **Apache-2.0**.
The notices below are **third-party** licenses and are **not** the project
license authority. Do not treat them as dual-licensing the package.

## mattpocock/skills (MIT)

Upstream provenance: [mattpocock/skills](https://github.com/mattpocock/skills).

This package ships or will ship pinned snapshots of the following skills from
that upstream repository. Each shipped method records immutable upstream
commit/tag identity, per-file digests and git blob OIDs, and attribution under
`resources/methods/<name>/provenance.json`.

- `tdd` — shipped unchanged under `resources/methods/tdd/` from upstream
  `skills/engineering/tdd` at commit `8b36d4fb2635b3c21998dcd8144439c9e5ba7302`
  (tag `v1.2.2`) (#109)
- `diagnosing-bugs` — shipped under `resources/methods/diagnosing-bugs/` from
  upstream `skills/engineering/diagnosing-bugs` at the same commit/tag, with
  package adaptation `fixer-boundary-no-external-skill-chain` so the Fixer
  method cannot automatically launch architecture Grill or other role-external
  Skill chains (#110)
- `code-review` — later method-bearing role ticket
- `resolving-merge-conflicts` — later method-bearing role ticket

The complete upstream MIT license text follows.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
