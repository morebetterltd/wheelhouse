# wheelhouse-project-bf3 evidence summary

Change under test: `BOOTSTRAP.md` Q8 provider prose now names plain `openai` as the role-sensible designer API-key provider and explicitly says the designer/API-key option list must include visible `openai`, not only `openai-codex`, `anthropic`, and `google`.

## Source failure from 6q1

`fleet/wheelhouse-project-6q1:evidence/wheelhouse-project-6q1/run1/askuserquestion-capture.jsonl:19` showed the first designer provider question offered `openai-codex`, `anthropic`, and `google`; the fixture had to answer `FREE_TEXT_MISS`. Line 20 recovered only after retry added `openai`.

## Free fixture replay

Run: `env WHEELHOUSE_INTERVIEW_MODEL=none/none wheelhouse/crew/bench.sh --mode interview --ref c39e2d2 .wheelhouse-worktrees/wheelhouse-project-bf3 <outdir>`.

The bench invocation exits nonzero because `none/none` deliberately refuses the live interviewer, but `fixture-replay.jsonl` is still written and is the free leg. Evidence:

- `free/fixture-replay.jsonl`: 13 rows, 0 misses.
- Designer provider replay row answers `openai` without free text.

## Live run

Run: `WHEELHOUSE_INTERVIEW_BENCH_TIMEOUT_MS=480000 wheelhouse/crew/bench.sh --mode interview --ref c39e2d2 .wheelhouse-worktrees/wheelhouse-project-bf3 <outdir>`.

This was a credentialed conducted run with interviewer `openai-codex/gpt-5.5`. It did not produce a full PASS because the live interviewer got stuck/retried on Q7 wording and the harness recorded unrelated Q7 free-text misses. The acceptance criterion for this bead is the initial designer provider question, and that passed:

- `live2/askuserquestion-capture.jsonl:26` is the initial designer provider question.
- Its options include `openai`, `openai-codex`, and `anthropic`.
- Its answer is `openai`, `miss:false`.
- `live2/seats.json:45-51` records designer as provider `openai`, model `gpt-5.5`, authRoute `api_key`.

The remaining `FAIL FREE_TEXT_MISS` in `live2/verdict.txt:10` is not the bf3 defect: the captured misses are Q7 crew questions before Q8, while Q8 designer provider did not miss.
