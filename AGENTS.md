# AGENTS.md

Operational guide for contributors to `@askrjs/fetch`.

## Scope

This repository owns typed HTTP contracts, generated clients, codecs, and
middleware. Keep changes focused on those public contracts and preserve the
standard Fetch API semantics.

## Ground rules

1. Keep `FetchResult` discriminated and transport failures explicit.
2. Preserve the public ESM entrypoints and generated-client compatibility.
3. Add or update tests for every changed result, codec, or middleware contract.
4. Keep package documentation aligned with the shipped API.

## Askr North Star

Keep each HTTP call narratable from an explicit contract and request through
middleware to a discriminated result. Enforce invalid contracts, codecs, and
middleware composition with errors that identify the misuse and correction.
Test thrown, transport, decode, abort, retry, and cleanup failure paths as
distinct outcomes. Preserve the seams between contracts, generated clients,
codecs, middleware, and the platform Fetch API. Prefer explicit endpoints and
middleware order over discovery or auto-wiring. Add surface only for a
demonstrated application need.

## Validation

Run `npm run check` before opening a pull request. It covers formatting,
linting, type checking, unit tests, the build, package smoke tests, and
publint.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
