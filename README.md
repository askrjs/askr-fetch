# @askrjs/fetch

[![CI](https://github.com/askrjs/askr-fetch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/askrjs/askr-fetch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40askrjs%2Ffetch.svg)](https://www.npmjs.com/package/@askrjs/fetch)

Function-first HTTP contracts, typed clients, codecs, and middleware for Askr. The package is
ESM-only, has no runtime dependencies, and works with the standard Fetch APIs in modern browsers
and Node.js 20.19 or newer.

## Install

```sh
npm install @askrjs/fetch
```

## Define and call an API

```ts
import { createClient, defineApi, get, json } from "@askrjs/fetch";

const api = defineApi({
  getUser: get("/users/{id}")
    .params<{ id: string }>()
    .query<{ include?: string[] }>({
      include: { style: "form", explode: true },
    })
    .returns(200, json<{ id: string; name: string }>())
    .errors({ 404: json<{ title: string }>() }),
});

const client = createClient(api, { baseUrl: "https://api.example.com" });
const result = await client.getUser({
  params: { id: "user-1" },
  query: { include: ["teams", "roles"] },
});

if (result.ok) {
  console.log(result.status, result.data.name);
} else if (result.kind === "http") {
  console.error(result.status, result.error);
} else {
  console.error(result.kind, result.error);
}
```

Paths use OpenAPI-style `{name}` parameters. Colon parameters and wildcards are rejected. A path
parameter declaration must exactly match the names in the path.

Every call returns a discriminated result instead of throwing for request, transport, HTTP, or
decode failures. Use `unwrap(result)` when exception-based control flow is more convenient.

## Codecs and validation

The built-in codecs are:

- `json(schema?)`
- `text()`
- `urlEncoded()`
- `multipart()`
- `blob()`
- `arrayBuffer()`
- `stream()`
- `empty()`
- `content({ mediaType: codec })`

For outbound bodies with more than one `content()` variant, pass
`bodyMediaType` explicitly. Single-variant codecs select their only variant
automatically:

```ts
await client.createDocument({
  body: "plain text",
  bodyMediaType: "text/plain",
});
```

An omitted or unknown media type produces a `request` failure, so declaration
order never selects a multi-variant request format.

A validator only needs a `safeParse(value)` method, so schema libraries with that contract can be
used without an adapter. Validators run for request bodies, path parameters, query parameters,
headers, and decoded response bodies. Successful validator transformations are used for
serialization and returned data.

```ts
const positiveInteger = {
  safeParse(value: unknown) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0
      ? { success: true as const, data: parsed }
      : { success: false as const, error: new TypeError("Expected a positive integer") };
  },
};

const api = defineApi({
  getJob: get("/jobs/{id}")
    .params<{ id: number }>({ id: positiveInteger })
    .returns(json<{ id: number }>()),
});
```

Responses are decoded against the codec registered for the actual HTTP status and content type.
Missing status codecs, incompatible media types, invalid payloads, and unexpected non-empty bodies
for `empty()` produce a `decode` failure. `204`, `205`, and `HEAD` responses must use `empty()`.

## Parameter serialization

Descriptors support the OpenAPI serialization styles used by generated clients:

- Path: `simple`, `label`, and `matrix`
- Query: `form`, `spaceDelimited`, `pipeDelimited`, and `deepObject`
- Header: `simple`

Use a parameter specification to combine serialization metadata with validation:

```ts
get("/search")
  .query<{ tags: string[]; filter: { state: string } }>({
    tags: { style: "pipeDelimited", explode: false },
    filter: { style: "deepObject", explode: true },
  })
  .returns(json());
```

Query serialization treats `null` as the literal `null` and `NaN` as the literal `NaN`, whether
the value is scalar or array-wrapped. `undefined` is omitted in both positions. This avoids
silently turning scalar `null` into an empty string or array-wrapped `undefined` into text.

## Middleware

Import middleware from the dedicated subpath:

```ts
import { createClient } from "@askrjs/fetch";
import { bearerAuth, logging, retry, telemetry } from "@askrjs/fetch/middleware";

const client = createClient(api, {
  baseUrl: "https://api.example.com",
  middleware: [
    retry({ attempts: 3 }),
    bearerAuth({ token: () => session.accessToken }),
    logging(),
    telemetry(hooks),
  ],
});
```

Middleware is a linear onion and runs outward in declaration order. Middleware after `retry()`
runs once per attempt; middleware before it runs once around the complete retry sequence. Put
token-refreshing authentication, per-attempt logging, and per-attempt telemetry after `retry()` as
shown above. Put aggregate timing or logging before `retry()` when one observation for the complete
sequence is intentional. Logging redacts common credential names as well as arbitrary header or
query names added by `apiKeyAuth()`.

Retries default to `GET`, `HEAD`, `PUT`, `DELETE`, and `OPTIONS`, and to statuses `408`, `425`,
`429`, `500`, `502`, `503`, and `504`. `Retry-After` is honored when present. Cloneable request
bodies are replayed with the original bytes and headers. `ReadableStream` bodies are explicitly
single-attempt so retry does not buffer an unbounded stream. If an earlier middleware has already
consumed any body, retry also sends it once and does not surface an incidental cloning error.

Do not include a status such as `401` in `retry()` when an upstream authentication middleware
already handles that status. The outer authentication layer cannot react until retry's complete
inner attempt loop returns, so including `401` would spend the retry budget on the same upstream
credentials. Prefer the order above so credentials resolve per attempt, or let the authentication
middleware own `401` without adding it to retry's statuses.

## Cancellation and timeouts

Set a default timeout on the client or override it for one call. A caller `AbortSignal` is composed
with the timeout signal. Timeouts return `kind: "timeout"`; caller cancellation returns
`kind: "abort"`.

```ts
const controller = new AbortController();
const pending = client.getUser({
  params: { id: "user-1" },
  signal: controller.signal,
  timeout: 5_000,
});

controller.abort();
const result = await pending;
```

## Lower-level requests

`createFetch(options)` exposes the same result, codec, middleware, timeout, and cancellation
contracts without an API descriptor. Supply either an absolute URL or a `baseUrl` plus a rooted
path.

```ts
import { createFetch, json } from "@askrjs/fetch";

const execute = createFetch({ baseUrl: "https://api.example.com" });
const result = await execute({
  url: "/health",
  response: json<{ status: "ok" }>(),
});
```
