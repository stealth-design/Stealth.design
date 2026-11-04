# Documentation

The fifteen documents §39 asks for, in the order they are useful.

## Getting it running

| | |
|---|---|
| [local-development.md](local-development.md) | Install, run, and the first crawl end to end |
| [environment.md](environment.md) | Every environment variable, what it does, what happens if it is wrong |
| [worker.md](worker.md) | Running the capture worker, and why its environment is deliberately tiny |

## Doing the work

| | |
|---|---|
| [test-crawl.md](test-crawl.md) | Running a single-URL crawl and reading the result |
| [bulk-ingest.md](bulk-ingest.md) | Submitting hundreds of URLs, and what the validation screen is telling you |
| [review-and-publish.md](review-and-publish.md) | The review queue, the publish gate, and what "published" actually means |

## How it is built

| | |
|---|---|
| [architecture.md](architecture.md) | The processes, the packages, and the decisions worth defending |
| [database.md](database.md) | 32 tables, and why the content model is shaped the way it is |
| [ingestion-pipeline.md](ingestion-pipeline.md) | Discover → ingest → capture → review → classify → approve → publish → recapture |
| [media.md](media.md) | Storage keys, deduplication, derivatives, and the upload screen |
| [api.md](api.md) | The three API surfaces and what separates them |
| [cms-routes.md](cms-routes.md) | Every screen, what it is for, and what it reads |

## Judgement

| | |
|---|---|
| [security.md](security.md) | The threat model, the controls, and what is enforced by a test |
| [known-limitations.md](known-limitations.md) | What is missing, wrong, or dev-only — stated plainly |
| [next-steps.md](next-steps.md) | What to build next, in priority order, with reasons |

## Reading order

If you have twenty minutes: [architecture.md](architecture.md), then
[ingestion-pipeline.md](ingestion-pipeline.md), then
[security.md](security.md). Those three explain why almost every other
decision in the codebase is what it is.

If you are about to write code here: add [known-limitations.md](known-limitations.md)
to that list. It is the document most likely to save you from re-discovering
something the hard way.
