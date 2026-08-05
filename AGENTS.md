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

## Validation

Run `npm run check` before opening a pull request. It covers formatting,
linting, type checking, unit tests, the build, package smoke tests, and
publint.
