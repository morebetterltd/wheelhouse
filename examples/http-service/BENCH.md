# Review Bench — HTTP service and job worker (EXAMPLE IMPLEMENTATION)

> This is ONE project's bench: an invented service called Tideline, which ships
> an HTTP API and a job worker from a single root. It is here because reading a
> real one beats reading a spec, and because the Android example beside it does
> not exercise the two clauses that are hardest on a server stack. Yours will
> share the contract in `contracts/BENCH.md` and share almost none of these
> details. Do not copy it; read it, then write your own against the contract.

Tideline stores tide readings and summarises them asynchronously. Two deployables:

| | |
|---|---|
| `tideline-api` | HTTP service. Stores readings, serves them back, queues summary jobs. |
| `tideline-worker` | Consumes the queue, writes a summary back to the record. |

## The artifact, when a project ships more than one

The contract says the bench takes an artifact and returns an exit code. A project with two deployables has no single image to hand it, and benching them separately would never catch the thing most likely to break — that the worker and the API disagree about the schema they share.

So the artifact here is a **release manifest**: a file naming both image digests.

```
api: registry.example.net/tideline-api@sha256:3f8c…
worker: registry.example.net/tideline-worker@sha256:91ab…
```

One argument in, one exit code out, and the thing named is the thing that ships. The bench refuses a manifest that names tags rather than digests, because a tag can move between the build a reviewer approved and the bench that claims to have tested it.

The manifest is written by whatever builds the images — a release job, a tagging script, a human running one command. Nothing in this bench produces it, and nothing should: a bench that can generate its own artifact description can generate one that agrees with itself. Say in your own project section who writes it and when.

If your project ships one artifact, pass the artifact. If it ships four, the manifest grows and nothing else changes.

### When you cannot bench them all yet

The common install-time reality is a second deployable that is one placeholder line — a directory, a stub, an intention. Benching a seam that does not exist yet is not possible, and waiting for it means shipping no bench at all.

So the interim rule: **scope the bench to what exists, and record the scope where a reviewer will meet it.** Name in your project section which deployables the bench covers and which it does not, and why. That is an honest gap, which this template prefers to an invented assertion, and it converts a silent scope choice into a fact someone can act on — most of all for whoever reviews a change to the part nothing benches.

What must not happen is the unrecorded version: a bench per deployable and none for the seam, with nothing saying so. The seam is where an API and its worker disagree about the schema they share, and a project that has quietly decided not to test it should have decided that out loud.

## The eight clauses, each satisfied concretely

**1. One command, artifact in, exit code out.** `bench.sh <release-manifest> <output-dir>`. Exit 2 for misuse, 1 for a failed bench, 0 only from the success path.

**2. It exercises the built artifact.** The digests from the manifest are pulled and run as-is. No `docker build` from the working tree, no dev server, no `uvicorn --reload`. The commonest way to fail this clause on a service is to bench the thing you run locally rather than the image you ship; they differ in exactly the ways that bite in production — base image, entrypoint, environment.

**3. It starts from clean state, every run.** A throwaway database container per run, no volume, migrated from empty, dropped by the teardown. This is the clause the Android example cannot demonstrate and the one a service stack gets wrong most often: a bench pointed at a development database passes on rows it did not create, and keeps passing after the code that created them is deleted. Every container name carries the run id, so two runs cannot collide and a leaked container from an earlier run cannot be mistaken for this one's.

**4. Liveness is not success.** A container that is up proves a container is up. `/healthz` returning 200 proves a health endpoint exists — a Tideline API with every business route removed still answers it. So the bench stores a reading through the public API, reads it back, and asserts the record served is the record stored; then queues a summary job and requires the *worker* to be what completes it. The last assertion is the one worth copying: after the job reports `done`, the bench checks the summary is actually there. A worker that marks jobs complete without doing them passes every check that only reads the state field.

**5. It retains evidence.** The output directory holds the manifest actually benched, the migration log, the created and served records, the summarised record, and the logs of all three containers — written by the teardown, so they exist on a failed run too, which is when they are worth having.

**6. It always tears down.** `trap cleanup EXIT INT TERM`, containers and network removed on every path. Three things learned by measuring rather than assuming, all encoded in the script, and the third only after a reviewer found it in the first version of this file:

- **How you deliver the signal decides whether the trap exists at all**, and this is where the first version of this file was wrong. A process started in the background from a non-interactive shell inherits SIGINT as `SIG_IGN`, and a signal ignored on entry cannot be trapped — so `trap cleanup INT` is silently a no-op and `kill -INT` runs nothing. Measured, four ways:

  | delivery | result |
  |---|---|
  | background from a script, `kill -INT` | ran to completion; only the EXIT trap fired |
  | background from a script, `kill -TERM` | trap fired at once |
  | parent resets the disposition, then execs, `kill -INT` | trap fired at once |
  | script signals itself in the foreground | trap fired at once |

  The first row is the trap: it looks like the teardown "ran late", because the EXIT trap eventually runs and prints the same lines. It did not run late. It never ran, and the run reported success.

  **So verify your teardown with `SIGTERM`, or reset the disposition in the PARENT before spawning.** Resetting it inside the child does not work — measured: a script doing `trap - INT` on itself still ran to completion, because by then the disposition was already inherited. A reader who checks their own teardown by backgrounding it and sending SIGINT tests nothing and gets a pass.
- Worse, the trap then sees `$? = 0`, so an interrupted run exits 0 and reports success to anything reading the exit code. The script carries a `PASSED` flag set only on the success path, and the teardown forces a non-zero exit when it is unset. A bench that can exit 0 without finishing is not a bench.
- **A cleanup handler that ends in `exit` and is trapped on `EXIT` as well as `INT` runs twice.** The signal trap fires, the handler exits, and that exit re-enters the same handler. Pass one captured the logs and removed the containers; pass two found them gone, and `>` truncates the file before the command fails — so all three captured logs became `Error: No such container`, on precisely the interrupted run where a human wants them most. Measured before and after: two passes and 28-byte logs, against one pass and the real contents. `trap - EXIT INT TERM` inside the handler is the whole fix — placed after `rc=$?`, which has to run first, and before anything the handler would rather not repeat. Note what this defect was immune to: the exit code was correct throughout, so any check that only asked "did it fail?" passed it.

**7. Measurements are not verdicts.** The bench times twenty sequential reads and writes them to `latency.txt`. It never compares them to a threshold, because it cannot: this runs a database and two containers on whatever machine invoked it, so the number cannot distinguish a slow service from a loaded host. It is there for a reviewer comparing runs, and it says so.

**8. Re-runnable by someone who did not write it.** Prerequisites below, no hidden state, and run-scoped names so a second reviewer can run it while the first is still running.

## Prerequisites

`docker` with a running daemon, `curl`, and `jq`. The registry must be reachable, or the images already present locally. Nothing else — no language runtime, because the artifact carries its own.

## What was exercised, and what was not

Stated because a bench that has never run is a claim about behaviour like any other.

**Exercised:** argument handling (no arguments, missing manifest), the digest-not-tag refusal, the teardown firing on a failure path, the `PASSED` flag forcing a non-zero exit when the success path is not reached, the four signal-delivery contexts in the table above, and the teardown running exactly once with its captured logs intact.

The last two were measured against **stand-ins** — scripts of the same shape, not this bench — because they need no daemon and this machine had none. Read the byte counts accordingly: the stand-in's truncated log was 28 bytes of `No such container`; a real daemonless `docker logs` writes 122 bytes of connection error instead. Same defect, different text, and neither number is a property of this script.

One correction worth reading, because it is the failure this section exists to prevent, committed by this section: the first version claimed the interrupt case was exercised. It was exercised **through a background `kill -INT`**, which the table above shows runs no trap at all. The `PASSED` guard was genuinely exercised — by a stand-in that reached the end without setting it — but not via an interrupt. A claim of coverage was made about the one path that had not been covered.

**Not exercised:** anything that needs a live daemon. The project is invented and there are no images to pull, so every service-facing assertion describes what this bench would do against the project it was written for. Adapt those rather than trusting them.

The line between the two is not where you would guess, and getting it wrong here cost a real defect. The first version of this doc drew it at "everything from `docker pull` onward" — but the first `docker` calls in the script are inside `cleanup`, which runs *before* any pull on a failed or interrupted run. What had been measured was the teardown's exit code, which needs no daemon; what had not was the teardown's body, which is where the bug was. The sentence vouched for more than the testing supported, and it was one clause away from catching the thing it was covering up.

So when you write this section in your own bench doc, draw the line by **what you actually ran**, not by where the external dependency appears in the file. Say which paths you have run, because the reader cannot tell from the source which ones you did — and neither, it turns out, can the author.
