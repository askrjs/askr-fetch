# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Breaking changes

- Prepare the 0.5.0 root and middleware barrels as a curated 31-name surface,
  reduced from 54 names. Remove `pathNames`, the twenty implementation/inference
  type aliases listed in [the complete API migration](docs/0.5.0-api.md), and
  middleware `RetryOptions`/`TelemetryHooks`. Use endpoint factories, inferred
  operation/client types and `Parameters` for middleware configuration; retain
  `ClientOptions`, `Codec`, `FetchResult`, `Middleware` and `Validator`.

### Added

- Verify the complete runtime/declaration surface and removed/private imports
  from a real packed install in three-OS CI, with source coverage reports.

### Fixed

- Stop a retry when cancellation occurs between its backoff timer and awaiting
  continuation, and skip transport after asynchronous middleware has outlived
  caller cancellation or timeout.
- Settle cancelled calls without waiting for stalled middleware or custom
  transports; consume late failures and prevent late responses from starting
  stream ownership or replacing the cancelled result.
- Cancel undelivered response streams and release call cleanup when outward
  middleware stalls or throws, preserving the primary failure if source
  cancellation itself rejects.
- Preserve abort/timeout causes when buffered body decoding is interrupted,
  including the response identity, status and request URL.
- Preserve timeout classification when a timeout ends retry backoff, including
  after a backwards wall-clock adjustment.
- Update compatible development tooling and transitive dependencies to clear
  the reported formatter/worker and source-map advisories.
- Run packed-test npm commands through Node so the test executes on Windows.

## 0.4.2 - 2026-09-30

### Fixed

- Avoid teeing response streams when decoding so unread stream branches do not
  buffer the full response in memory.
- Keep caller abort signals and request timeouts active while a streamed
  response body is being consumed.
