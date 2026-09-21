# Scrubbed real claude-code verifier verdict — p2tl-real

- command: `bun seats/verify.ts p2tl-real fleet/bead-1 worker-1 verifier --timeout-ms 300000`
- harness/account: claude-code verifier seat using `~/.pi-seats-releaf/reviewer`
- exit: 2 (BOUNCE)
- branch: fleet/bead-1
- verdict: BOUNCE — real claude fixture
- push: NOT CONSIDERED — fixture

Dispatcher output:

```text
VERDICT: BOUNCE — real claude fixture  (bead p2tl-real, tip 6c9d6a45c0df, verifier verifier)
  full output -> [run]/real-claude-rework/proj/seats/verdicts/p2tl-real.md
```

Final assistant text captured by the verdict file:

```text
Fixture bead: the stated Done is to emit the two machine lines verbatim, with no branch inspection and no tool use. Following it as written.

VERDICT: BOUNCE — real claude fixture
PUSH: NOT CONSIDERED — fixture
```
