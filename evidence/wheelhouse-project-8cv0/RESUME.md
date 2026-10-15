# Resume 8cv0 only after 06:00 local

This is a checkpoint, NOT a completed bead or review handoff. `needs-review`
is unset. Commander explicitly accepted pausing the queued sweep.

Branch: `fleet/wheelhouse-project-8cv0`, originally cut from `origin/main`
`c8d156f5c61dc65784110902b4b8eb143c3944d1`.
Tested runtime: `34c1c34f04621fa4687de63ad24a8ba10617ae77`.
Evidence-only commits leave its `seats/` tree unchanged.

The clean asynchronous setsid standalone exits 0. Removing only the fixture
release hold exits 1; removing only native exit-record publication exits 1.
The original initial launch death remains unexplained. Commander accepted
instrumentation, with follow-up only if an instrumented occurrence catches it.
The separate state-lock timeout investigation is `wheelhouse-project-woq6`;
no state-lock runtime changes belong in this branch.

The official full attempt was canceled while QUEUED at 22:33 EDT: exit143,
zero inner-suite STARTs of 48. It is neither a pass nor a natural test failure.
Only the validated owned official outer runner received TERM. Safety PASS;
three permitted commander reflog entries. The 23:00 guard observed completion
and sent no signals. Do not overwrite these captures or count them as a gate.

After resumption, confirm the current ref is this branch and equals HEAD,
inspect current main and commander instructions, and compare `HEAD:seats`
with the recorded runtime. If rebasing/changing runtime, preserve the old
capture provenance and rerun standalone plus both single-file removal controls
at the new runtime; do not silently relabel the existing results.

Run a fresh full gate through `bash seats/selftest-sweep.sh`, not a hand-made
suite loop. Keep the approved dual-domain bridge while needed; all scratch
roots and logs belong under this bead's `.wheelhouse-runs/` directory. Keep
`seats/bin` on PATH, owned TMPDIR/Git ceilings, real-provider skip, independent
stdout/stderr/exit capture and umbrella protection. Use a NEW run name (for
example `full-after-06`) so the canceled `full.*` remains intact.

Verify exact unique START/PASS inventories against the committed tree, not
just the aggregate. The prepared `assert-sweep.cjs` still needs a real positive
capture and a control deleting only one actual PASS receipt, which must fail
while leaving the aggregate unchanged. Update evidence/README and retain
source identity/redaction/whitespace/branch-tip checks against the final
committed tree. Post a Done-by-Done report, request exact-tip receipt, then
add `needs-review`. Do not close, merge or push.
