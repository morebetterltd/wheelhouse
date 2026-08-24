# The Wheelhouse Manifesto

> Build it per project. Not for everyone.

## What a wheelhouse is

A wheelhouse is a self-contained software factory for a single contributor working on a single product. It is not a universal development environment and it is not a global configuration. It is machinery scoped to one project: it knows exactly what that project needs, and it stays out of everything else.

## Principles

### One wheelhouse per project

Every project gets its own wheelhouse. Not one per repository, since a project may span several repos, but one factory per product. The wheelhouse and everything in it converge on the product being built. Nothing more.

### Project-specific over global

The wheelhouse holds whatever environment, configuration, and conventions its project requires. It does not inherit from a shared global setup, and it does not try to serve every possible use case. A setup that tries to serve every project serves each one poorly; a wheelhouse is purpose-built for its own.

### Signal-driven development

The wheelhouse knows where its signal comes from: direct intent from the person steering it, issues and bug reports, feedback channels, automated alerts. Signal becomes needs, needs become work in the graph, and work gets done. Signal a wheelhouse is not pointed at is signal it will never act on.

### The factory runs itself

Once configured, the wheelhouse operates on its own: it manages its workflow, delegates to its workers, and converges on outcomes without hand-holding. The contributor steers. The wheelhouse executes.

## What a wheelhouse is not

| Not this | But this |
|----------|----------|
| A global dotfiles repo | A project-scoped environment definition |
| One-size-fits-all tooling | Selective, purposeful dependencies |
| Manual setup every time | A repeatable, verified install |
| Shared across all your work | Isolated and focused per product |

## In one sentence

> The wheelhouse is a software factory for one: one contributor, one project, one purpose-built machine that converges on the product and nothing else.

## Getting started

The install procedure lives in [`BOOTSTRAP.md`](BOOTSTRAP.md), and the [README](README.md) tells you how to invoke it. This manifesto is the why; BOOTSTRAP is the how, and it is authoritative where the two might seem to overlap.

## Credit

The conceptual source of the wheelhouse and fleet model is Steve Yegge's essay [*The Shape of Things to Come*](https://yegge.ai/essays/the-shape-of-things-to-come/). The manifesto also draws on Indy Dev Dan's per-project approach to agentic workflows: build the environment for the project at hand, tuned to that product's demands, rather than a universal configuration that serves every use case equally poorly.
