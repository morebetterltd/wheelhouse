# pstack adaptation notice

The create-verification and maintain-verification skills, including the adapted
feature-map example, are adapted from Lauren Tan's pstack skills under MIT.

Source: https://github.com/cursor/plugins/tree/190d28736eff128ec94f502a22c7fe0c4b56cd37/pstack
Fetched commit: 190d28736eff128ec94f502a22c7fe0c4b56cd37 (2026-10-21).
Upstream files: `skills/create-verification-skill/SKILL.md`,
`skills/maintain-verification-skill/SKILL.md`, and
`skills/create-verification-skill/references/feature-map-example/`.
The upstream `plugin.json` names Lauren Tan as author and MIT as its license.

## Adaptations — 2026-10-21

- Use tool-neutral names and `.agents/skills/verify-<project>/`, where the project
  identifier is the product repository's directory basename. Installation handles
  each harness's links; the skill text contains no vendor-specific folder names.
- Version both skills at 1.0.0 using the template's skill frontmatter convention.
- Fix the manual to Launch, Doctor, Drive, Evidence and Cleanup, in that order;
  document helpers within those sections and preserve the prove-one-feature,
  evidence-survives-cleanup rule.
- Map every discovered consumer feature, not an initial shortlist. Change each
  feature entry to What it is, How to get to it, How to drive it, and What proves
  it works. Retain the Notes example's consumer paths and proof principles in
  that shape, with explicit illustrative-driver and isolation caveats.
- Add the no-runnable-surface declaration: `surface: none`, two body sentences,
  and an empty feature map instead of invented launch instructions.
- Replace parallel reader delegation with one reader loop and one live pass.
  Maintenance reports findings only; it never edits product, manual, map or
  helper files and never creates branches, commits or pull requests.
- Replace the offered maintenance command with a sentence that the factory runs
  maintenance on a schedule. Make isolation, ownership-safe cleanup, coverage
  limits and retained evidence explicit without naming a particular tool.

## Upstream license (verbatim)

MIT License

Copyright (c) 2026 Lauren Tan

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
