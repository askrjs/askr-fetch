# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.4.2 - 2026-09-30

### Fixed

- Avoid teeing response streams when decoding so unread stream branches do not
  buffer the full response in memory.
- Keep caller abort signals and request timeouts active while a streamed
  response body is being consumed.
