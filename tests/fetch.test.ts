import { readFile } from "node:fs/promises";
import { schema } from "@askrjs/schema";
import { describe, expect, it, vi } from "vitest";
import {
  arrayBuffer,
  blob,
  content,
  createClient,
  createFetch,
  defineApi,
  del,
  empty,
  FetchError,
  get,
  head,
  json,
  multipart,
  options,
  patch,
  pathNames,
  post,
  put,
  stream,
  text,
  unwrap,
  urlEncoded,
  type Codec,
  type Middleware,
  type Validator,
} from "../src";
import { apiKeyAuth, bearerAuth, logging, retry, telemetry } from "../src/middleware";

describe("fetch contracts", () => {
  it("should infer required path values given a brace parameter when calling", async () => {
    const transport = vi.fn(
      async (request: Request) =>
        new Response(JSON.stringify({ url: request.url }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createClient(
      defineApi({
        getUser: get("/users/{id}")
          .params<{ id: string | number }>()
          .returns(json<{ url: string }>()),
      }),
      { baseUrl: "https://example.test", fetch: transport },
    );
    // @ts-expect-error path params are required by the operation contract
    expect(await client.getUser()).toMatchObject({ ok: false, kind: "request" });
    expect(await client.getUser({ params: { id: 7 } })).toMatchObject({
      ok: true,
      data: { url: "https://example.test/users/7" },
    });
  });
  it("should reject non-brace paths given colon wildcard or malformed syntax when defining", () => {
    for (const path of ["/users/:id", "/files/*", "/users/{", "/{id}/{id}", "/{id}/}"])
      expect(() => get(path)).toThrow();
  });
  it("should reject missing and extra declarations given path params when configuring", () => {
    expect(() => get("/{id}").params({})).toThrow();
    expect(() => get("/{id}").params({ id: undefined, extra: undefined })).toThrow();
  });
  it("should return every failure kind given failures when executing", async () => {
    const network = createFetch({
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(await network({ url: "https://x.test", response: text() })).toMatchObject({
      kind: "network",
    });
    const decode = createFetch({
      fetch: async () => new Response("no", { headers: { "content-type": "text/plain" } }),
    });
    expect(await decode({ url: "https://x.test", response: json() })).toMatchObject({
      kind: "decode",
    });
    const http = createFetch({
      fetch: async () =>
        new Response("bad", { status: 400, headers: { "content-type": "text/plain" } }),
    });
    expect(await http({ url: "https://x.test", errors: { 400: text() } })).toMatchObject({
      kind: "http",
      error: "bad",
    });
    const middleware = createFetch({
      middleware: [
        async () => {
          throw new Error("bad");
        },
      ],
    });
    expect(await middleware({ url: "https://x.test", response: text() })).toMatchObject({
      kind: "middleware",
    });
  });
  it("should distinguish timeout from caller abort given cancellation when executing", async () => {
    const hanging = async (request: Request) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (request.signal.aborted) throw request.signal.reason;
      throw new Error("transport did not observe cancellation");
    };
    expect(
      await createFetch({ fetch: hanging, timeout: 5 })({
        url: "https://x.test",
        response: text(),
      }),
    ).toMatchObject({ kind: "timeout" });
    const controller = new AbortController();
    const pending = createFetch({ fetch: hanging })({
      url: "https://x.test",
      response: text(),
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ kind: "abort" });

    const transport = vi.fn(async () =>
      Promise.resolve(new Response("ok", { headers: { "content-type": "text/plain" } })),
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("cancelled before dispatch"));
    expect(
      await createFetch({ fetch: transport })({
        url: "https://x.test",
        response: text(),
        signal: alreadyAborted.signal,
      }),
    ).toMatchObject({ kind: "abort" });
    expect(transport).not.toHaveBeenCalled();
  }, 15_000);
  it("should decode codecs given actual compatible content types when responding", async () => {
    const execute = createFetch({
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    const result = await execute({ url: "https://x.test", response: arrayBuffer() });
    expect(result.ok && [...new Uint8Array(result.data as ArrayBuffer)]).toEqual([1, 2]);
    expect(() => del("/x").returns(204, json())).toThrow();
    expect(del("/x").returns(204, empty())).toBeDefined();
  });
  it("should infer issue-based validator data and preserve failures while decoding", async () => {
    const legacyError = new TypeError("legacy validator failure");
    const legacyValidator: Validator = {
      safeParse: () => ({ success: false, error: legacyError }),
    };
    const legacyResult = legacyValidator.safeParse(undefined);
    expect(legacyResult.success ? undefined : legacyResult.error).toBe(legacyError);

    const userSchema = schema.object({
      id: schema.uuid(),
      name: schema.string({ minLength: 1 }),
    });
    const userCodec = json(userSchema);
    userCodec satisfies Codec<{ id: string; name: string }>;
    const validUser = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Ada",
    };
    const invalidUser = { id: "not-a-uuid", name: "" };
    const invalidUserResult = userSchema.safeParse(invalidUser);
    expect(invalidUserResult.success).toBe(false);
    if (invalidUserResult.success) throw new Error("Expected invalid user fixture");

    const decoded = await createFetch({
      fetch: async () =>
        new Response(JSON.stringify(validUser), {
          headers: { "content-type": "application/json" },
        }),
    })({ url: "https://x.test/users/1", response: userCodec });
    expect(decoded).toMatchObject({ ok: true, data: validUser });

    const invalidDecoded = await createFetch({
      fetch: async () =>
        new Response(JSON.stringify(invalidUser), {
          headers: { "content-type": "application/json" },
        }),
    })({ url: "https://x.test/users/1", response: userCodec });
    expect(invalidDecoded).toMatchObject({
      ok: false,
      kind: "decode",
      error: invalidUserResult.issues,
    });
  });

  it("should preserve issue-based validator failures before encoding request bodies", async () => {
    const userSchema = schema.object({
      id: schema.uuid(),
      name: schema.string({ minLength: 1 }),
    });
    const userCodec = json(userSchema);
    const invalidUser = { id: "not-a-uuid", name: "" };
    const invalidUserResult = userSchema.safeParse(invalidUser);
    if (invalidUserResult.success) throw new Error("Expected invalid user fixture");
    const bodyTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const invalidBody = await createFetch({ fetch: bodyTransport })({
      url: "https://x.test/users",
      method: "POST",
      body: invalidUser,
      bodyCodec: userCodec,
      response: empty(),
    });
    expect(invalidBody).toMatchObject({
      ok: false,
      kind: "request",
      error: invalidUserResult.issues,
    });
    expect(bodyTransport).not.toHaveBeenCalled();
  });

  it("should preserve issue-based validator failures before serializing parameters", async () => {
    const idSchema = schema.uuid();
    const invalidIdResult = idSchema.safeParse("not-a-uuid");
    if (invalidIdResult.success) throw new Error("Expected invalid id fixture");
    const api = defineApi({
      read: get("/users/{id}").params<{ id: string }>({ id: idSchema }).returns(empty()),
    });
    const parameterTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const invalidParameter = await createClient(api, {
      baseUrl: "https://x.test",
      fetch: parameterTransport,
    }).read({ params: { id: "not-a-uuid" } });
    expect(invalidParameter).toMatchObject({
      ok: false,
      kind: "request",
      error: invalidIdResult.issues,
    });
    expect(parameterTransport).not.toHaveBeenCalled();
  });
  it("should round-trip every body codec through Fetch request and response objects", async () => {
    const roundTrip = async (body: unknown, bodyCodec: Codec) =>
      createFetch({
        fetch: async (request) => {
          const headers = new Headers();
          const contentType = request.headers.get("content-type");
          if (contentType) headers.set("content-type", contentType);
          return new Response(await request.arrayBuffer(), { headers });
        },
      })({
        url: "https://x.test",
        method: "POST",
        body,
        bodyCodec,
        response: bodyCodec,
      });

    await expect(roundTrip({ value: null }, json())).resolves.toMatchObject({
      ok: true,
      data: { value: null },
    });
    await expect(roundTrip("", text())).resolves.toMatchObject({ ok: true, data: "" });
    const parameters = new URLSearchParams({ value: "a b" });
    const encoded = await roundTrip(parameters, urlEncoded());
    expect(encoded.ok && (encoded.data as URLSearchParams).get("value")).toBe("a b");

    const form = new FormData();
    form.set("value", "multipart");
    const multipartResult = await roundTrip(form, multipart());
    expect(multipartResult.ok && (multipartResult.data as FormData).get("value")).toBe("multipart");

    const blobResult = await roundTrip(new Blob(["blob"]), blob());
    expect(blobResult.ok && (await (blobResult.data as Blob).text())).toBe("blob");
    const bufferResult = await roundTrip(new Uint8Array([1, 2]).buffer, arrayBuffer());
    expect(bufferResult.ok && [...new Uint8Array(bufferResult.data as ArrayBuffer)]).toEqual([
      1, 2,
    ]);

    const streamed = await createFetch({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode("chunk"));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    })({ url: "https://x.test", response: stream() });
    expect(streamed.ok && streamed.data).toBeInstanceOf(ReadableStream);

    const noContent = await createFetch({ fetch: async () => new Response(null, { status: 204 }) })(
      {
        url: "https://x.test",
        response: empty(),
      },
    );
    expect(noContent).toMatchObject({ ok: true, data: undefined });

    const negotiated = await createFetch({
      fetch: async () => new Response("negotiated", { headers: { "content-type": "text/plain" } }),
    })({
      url: "https://x.test",
      response: content({ "application/json": json(), "text/plain": text() }),
    });
    expect(negotiated).toMatchObject({ ok: true, data: "negotiated" });
  });
  it("should directly expose every HTTP builder, path parser, and unwrap outcome", async () => {
    expect(pathNames("/items/{id}/{part}")).toEqual(["id", "part"]);
    expect(patch("/x").returns(text())).toBeDefined();
    expect(head("/x").returns(200, empty())).toBeDefined();
    expect(options("/x").returns(text())).toBeDefined();
    expect(unwrap({ ok: true, kind: "success", status: 200, data: "ok" } as never)).toBe("ok");
    expect(() => unwrap({ ok: false, kind: "network" } as never)).toThrow(FetchError);
  });
  it("should preserve a declared request media type given a content codec when encoding", async () => {
    let contentType: string | null = null;
    const execute = createFetch({
      fetch: async (request) => {
        contentType = request.headers.get("content-type");
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    });
    await execute({
      url: "https://x.test",
      method: "POST",
      body: { title: "invalid" },
      bodyCodec: content({ "application/problem+json": json() }),
      response: text(),
    });
    expect(contentType).toBe("application/problem+json");
  });
  it("should explicitly select a request content variant independent of declaration order", async () => {
    const requests: Array<{ contentType: string | null; body: string }> = [];
    const transport = async (request: Request) => {
      requests.push({
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      });
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    };
    const variants = [
      content({ "application/json": json(), "text/plain": text() }),
      content({ "text/plain": text(), "application/json": json() }),
    ];

    for (const bodyCodec of variants) {
      const client = createClient(
        defineApi({ createDocument: post("/documents").body(bodyCodec).returns(text()) }),
        { baseUrl: "https://x.test", fetch: transport },
      );
      await client.createDocument({
        body: "plain body",
        bodyMediaType: "text/plain",
      });
    }

    expect(requests).toEqual([
      { contentType: "text/plain", body: "plain body" },
      { contentType: "text/plain", body: "plain body" },
    ]);

    const ambiguous = await createFetch({ fetch: transport })({
      url: "https://x.test",
      method: "POST",
      body: "plain body",
      bodyCodec: variants[0],
      response: text(),
    });
    expect(ambiguous).toMatchObject({ ok: false, kind: "request" });

    const unknown = await createFetch({ fetch: transport })({
      url: "https://x.test",
      method: "POST",
      body: "plain body",
      bodyCodec: variants[0],
      bodyMediaType: "application/xml",
      response: text(),
    });
    expect(unknown).toMatchObject({ ok: false, kind: "request" });
    expect(requests).toHaveLength(2);
  });
  it("should execute middleware outward given declaration order when responding", async () => {
    const events: string[] = [];
    const layer = (name: string) => async (context: any, next: any) => {
      events.push(`${name}:in`);
      const result = await next(context);
      events.push(`${name}:out`);
      return result;
    };
    await createFetch({
      middleware: [layer("a"), layer("b")],
      fetch: async () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    })({ url: "https://x.test", response: text() });
    expect(events).toEqual(["a:in", "b:in", "b:out", "a:out"]);
  });
  it("should report downstream middleware exceptions to telemetry before converting them", async () => {
    const events: string[] = [];
    const execute = createFetch({
      middleware: [
        telemetry({
          start: () => events.push("start"),
          end: () => events.push("end"),
          error: () => events.push("error"),
        }),
        async () => {
          throw new Error("downstream exploded");
        },
      ],
    });

    await expect(execute({ url: "https://x.test", response: text() })).resolves.toMatchObject({
      ok: false,
      kind: "middleware",
    });
    expect(events).toEqual(["start", "error"]);
  });
  it("should apply auth retry redaction and telemetry given polished middleware when executing", async () => {
    const logs: Record<string, unknown>[] = [];
    const spans: string[] = [];
    let calls = 0;
    const execute = createFetch({
      middleware: [
        bearerAuth({ token: "secret" }),
        logging({ log: (e) => logs.push(e) }),
        telemetry({ start: () => spans.push("start"), end: () => spans.push("end") }),
        retry({ attempts: 2, delay: () => 0 }),
      ],
      fetch: async (request) => {
        calls++;
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        return new Response(calls === 1 ? "later" : "ok", {
          status: calls === 1 ? 503 : 200,
          headers: { "content-type": "text/plain", "retry-after": "0" },
        });
      },
    });
    expect(
      await execute({ url: "https://x.test", response: text(), errors: { 503: text() } }),
    ).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("secret");
    expect(spans).toEqual(["start", "end"]);
  });
  it("should refresh auth and observe each attempt given the README middleware order", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const documented = readme.match(/middleware:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    expect(documented.indexOf("retry(")).toBeLessThan(documented.indexOf("bearerAuth("));
    expect(documented.indexOf("bearerAuth(")).toBeLessThan(documented.indexOf("logging("));
    expect(documented.indexOf("logging(")).toBeLessThan(documented.indexOf("telemetry("));

    const authorizations: (string | null)[] = [];
    const logs: Record<string, unknown>[] = [];
    const spans: string[] = [];
    let tokenCalls = 0;
    const execute = createFetch({
      middleware: [
        retry({ attempts: 2, delay: () => 0 }),
        bearerAuth({ token: () => `token-${++tokenCalls}` }),
        logging({ log: (event) => logs.push(event) }),
        telemetry({ start: () => spans.push("start"), end: () => spans.push("end") }),
      ],
      fetch: async (request) => {
        authorizations.push(request.headers.get("authorization"));
        return new Response(authorizations.length === 1 ? "later" : "ok", {
          status: authorizations.length === 1 ? 503 : 200,
          headers: { "content-type": "text/plain", "retry-after": "0" },
        });
      },
    });

    await expect(
      execute({ url: "https://x.test", response: text(), errors: { 503: text() } }),
    ).resolves.toMatchObject({ ok: true });
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(logs).toHaveLength(4);
    expect(spans).toEqual(["start", "end", "start", "end"]);
  });
  it("should redact header and query API keys given auth before logging when executing", async () => {
    const logs: Record<string, unknown>[] = [];
    const logger = { log: (event: Record<string, unknown>) => logs.push(event) };
    const transport = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
    await createFetch({
      middleware: [apiKeyAuth({ key: "x-custom-key", value: "header-secret" }), logging(logger)],
      fetch: transport,
    })({ url: "https://x.test", response: text() });
    await createFetch({
      middleware: [
        apiKeyAuth({ key: "custom", value: "query-secret", in: "query" }),
        logging(logger),
      ],
      fetch: transport,
    })({ url: "https://x.test", response: text() });
    expect(JSON.stringify(logs)).not.toContain("header-secret");
    expect(JSON.stringify(logs)).not.toContain("query-secret");
    expect(JSON.stringify(logs)).toContain("REDACTED");
  });
  it("should retry configured statuses given an undecodable error response when executing", async () => {
    const transport = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("untyped", { status: 503, headers: { "content-type": "text/plain" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const result = await createFetch({
      middleware: [retry({ attempts: 2, delay: () => 0 })],
      fetch: transport,
    })({ url: "https://x.test", response: text() });
    expect(result).toMatchObject({ ok: true, data: "ok" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("should validate and clamp Retry-After before enforcing the deadline", async () => {
    const exercise = async (
      retryAfter: string,
      retryOptions: Parameters<typeof retry>[0],
      timeout?: number,
    ) => {
      const transport = vi
        .fn<(request: Request) => Promise<Response>>()
        .mockResolvedValueOnce(
          new Response("later", {
            status: 429,
            headers: { "content-type": "text/plain", "retry-after": retryAfter },
          }),
        )
        .mockResolvedValue(new Response("ok", { headers: { "content-type": "text/plain" } }));
      const result = await createFetch({
        middleware: [retry(retryOptions)],
        fetch: transport,
        ...(timeout === undefined ? {} : { timeout }),
      })({ url: "https://x.test", response: text(), errors: { 429: text() } });
      return { result, transport };
    };

    const fallback = vi.fn(() => 1_000);
    const malformed = await exercise("not-a-real-date", { attempts: 2, delay: fallback }, 5);
    expect(fallback).toHaveBeenCalledWith(2);
    expect(malformed.transport).toHaveBeenCalledTimes(1);

    const clamped = await exercise(
      "Fri, 31 Dec 9999 23:59:59 GMT",
      {
        attempts: 2,
        maxRetryAfter: 0,
      },
      5,
    );
    expect(clamped.result).toMatchObject({ ok: true });
    expect(clamped.transport).toHaveBeenCalledTimes(2);

    const valid = await exercise("0", { attempts: 2, delay: () => 1_000 });
    expect(valid.result).toMatchObject({ ok: true });
    expect(valid.transport).toHaveBeenCalledTimes(2);
    expect(() => retry({ maxRetryAfter: Number.NaN })).toThrow(/non-negative finite number/);
  });
  it("should isolate retries, content variants, and middleware state across concurrent calls", async () => {
    const count = 20;
    const attempts = new Map<string, number[]>();
    const requests = new Map<string, Array<{ body: string; contentType: string | null }>>();
    let firstAttempts = 0;
    let releaseFirstAttempts!: () => void;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempts = resolve;
    });
    const observe: Middleware = async (context, next) => {
      const id = context.request.headers.get("x-request-id")!;
      attempts.set(id, [...(attempts.get(id) ?? []), context.attempt]);
      return next(context);
    };
    const client = createClient(
      defineApi({
        replaceDocument: put("/documents/{id}")
          .params<{ id: string }>()
          .headers<{ "x-request-id": string }>()
          .body(content({ "application/json": json(), "text/plain": text() }))
          .returns(text())
          .errors({ 503: text() }),
      }),
      {
        baseUrl: "https://x.test",
        middleware: [retry({ attempts: 2, delay: () => 0 }), observe],
        fetch: async (request) => {
          const id = request.headers.get("x-request-id")!;
          const seen = requests.get(id) ?? [];
          seen.push({
            body: await request.text(),
            contentType: request.headers.get("content-type"),
          });
          requests.set(id, seen);
          if (seen.length === 1) {
            firstAttempts += 1;
            if (firstAttempts === count) releaseFirstAttempts();
            await firstAttemptGate;
            return new Response("later", {
              status: 503,
              headers: { "content-type": "text/plain", "retry-after": "0" },
            });
          }
          return new Response(id, { headers: { "content-type": "text/plain" } });
        },
      },
    );

    const results = await Promise.all(
      Array.from({ length: count }, (_, index) => {
        const id = String(index);
        const asJson = index % 2 === 0;
        return client.replaceDocument({
          params: { id },
          headers: { "x-request-id": id },
          body: asJson ? { id } : `document-${id}`,
          bodyMediaType: asJson ? "application/json" : "text/plain",
          timeout: 5_000,
        });
      }),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    for (let index = 0; index < count; index += 1) {
      const id = String(index);
      const asJson = index % 2 === 0;
      expect(attempts.get(id)).toEqual([1, 2]);
      expect(requests.get(id)).toEqual([
        {
          body: asJson ? JSON.stringify({ id }) : `document-${id}`,
          contentType: asJson ? "application/json" : "text/plain",
        },
        {
          body: asJson ? JSON.stringify({ id }) : `document-${id}`,
          contentType: asJson ? "application/json" : "text/plain",
        },
      ]);
    }
  });
  it.each([
    ["PUT", "status"],
    ["PUT", "network"],
    ["DELETE", "status"],
    ["DELETE", "network"],
  ] as const)("should retry replayable %s bodies after a %s failure", async (method, failure) => {
    const bodies: string[] = [];
    const headers: string[] = [];
    const transport = vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      headers.push(`${request.headers.get("content-type")}|${request.headers.get("x-request")}`);
      if (bodies.length === 1) {
        if (failure === "network") throw new Error("offline");
        return new Response("retry", {
          status: 503,
          headers: { "content-type": "text/plain", "retry-after": "0" },
        });
      }
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    });
    const result = await createFetch({
      middleware: [retry({ attempts: 2, delay: () => 0 })],
      fetch: transport,
    })({
      url: "https://x.test/resource",
      method,
      headers: { "x-request": "preserved" },
      body: { name: "updated" },
      bodyCodec: json(),
      response: text(),
      errors: { 503: text() },
    });

    expect(result).toMatchObject({ ok: true, data: "ok" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual(['{"name":"updated"}', '{"name":"updated"}']);
    expect(headers).toEqual(["application/json|preserved", "application/json|preserved"]);
  });
  it.each([
    ["a non-eligible POST", { method: "POST", timeout: undefined, delay: 0 }],
    ["an exhausted deadline", { method: "PUT", timeout: 5, delay: 1_000 }],
    ["the exact deadline boundary", { method: "PUT", timeout: 1_000, delay: 1_000 }],
  ] as const)("should preserve one attempt for %s", async (_label, options) => {
    const transport = vi.fn(async (request: Request) => {
      await request.text();
      return new Response("retry", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    });
    const result = await createFetch({
      middleware: [retry({ attempts: 2, delay: () => options.delay })],
      fetch: transport,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    })({
      url: "https://x.test/resource",
      method: options.method,
      body: { name: "unchanged" },
      bodyCodec: json(),
      response: text(),
      errors: { 503: text() },
    });

    expect(result).toMatchObject({ ok: false, kind: "http", status: 503 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("should skip retries without throwing when an earlier middleware consumed the body", async () => {
    const transport = vi.fn(async () =>
      Promise.resolve(new Response("ok", { headers: { "content-type": "text/plain" } })),
    );
    const consumeBody = async (context: any, next: any) => {
      await context.request.text();
      return next(context);
    };
    const result = await createFetch({
      middleware: [consumeBody, retry({ attempts: 2, delay: () => 0 })],
      fetch: transport,
    })({
      url: "https://x.test/resource",
      method: "PUT",
      body: "already consumed",
      bodyCodec: text(),
      response: text(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("should send streaming bodies once without an incidental replay error", async () => {
    const transport = vi.fn(async (request: Request) => {
      await request.text();
      return new Response("retry", {
        status: 503,
        headers: { "content-type": "text/plain", "retry-after": "0" },
      });
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    const result = await createFetch({
      middleware: [retry({ attempts: 2, delay: () => 0 })],
      fetch: transport,
    })({
      url: "https://x.test/resource",
      method: "PUT",
      body,
      bodyCodec: stream(),
      response: text(),
      errors: { 503: text() },
    });

    expect(result).toMatchObject({ ok: false, kind: "http", status: 503 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("should freeze builders clients and descriptors given an API when constructed", () => {
    const query = { q: { style: "form" as const, explode: true } };
    const api = defineApi({
      create: post("/x").body(json()).returns(201, json()),
      read: get("/x").query<{ q?: string }>(query).returns(text()),
    });
    query.q.explode = false;
    Object.assign(query, { added: undefined });
    expect(Object.isFrozen(api.endpoints.create)).toBe(true);
    expect(Object.isFrozen(api.endpoints.read.query)).toBe(true);
    expect(api.endpoints.read.query).toEqual({ q: { style: "form", explode: true } });
    expect(Object.isFrozen(createClient(api))).toBe(true);
  });
  it("should decode by literal status given multiple success responses when calling", async () => {
    const api = defineApi({
      create: post("/jobs")
        .headers<{ "x-mode"?: string }>({ "x-mode": { style: "simple" } })
        .body(json<{ name: string }>())
        .returns(201, json<{ id: string }>())
        .returns(202, text())
        .errors({ 409: json<{ title: string }>(), default: text() }),
    });
    const client = createClient(api, {
      baseUrl: "https://example.test",
      fetch: async (request) =>
        request.headers.get("x-mode") === "async"
          ? new Response("queued", { status: 202, headers: { "content-type": "text/plain" } })
          : new Response(JSON.stringify({ id: "job-1" }), {
              status: 201,
              headers: { "content-type": "application/json" },
            }),
    });
    const created = await client.create({
      body: { name: "deploy" },
      headers: { "x-mode": "sync" },
    });
    expect(created).toMatchObject({ ok: true, status: 201, data: { id: "job-1" } });
    const queued = await client.create({
      body: { name: "deploy" },
      headers: { "x-mode": "async" },
    });
    expect(queued).toMatchObject({ ok: true, status: 202, data: "queued" });
    if (created.ok && created.status === 201) created.data.id satisfies string;
    // @ts-expect-error body is required by this operation
    void client.create();
  });
  it("should serialize OpenAPI styles given structured parameters when calling", async () => {
    const requests: Request[] = [];
    const api = defineApi({
      read: get("/things/{coords}")
        .params<{ coords: number[] }>({ coords: { style: "label", explode: true } })
        .query<{ tags: string[]; filter: { state: string } }>({
          tags: { style: "pipeDelimited", explode: false },
          filter: { style: "deepObject", explode: true },
        })
        .headers<{ "x-flags": { dry: boolean; force: boolean } }>({
          "x-flags": { style: "simple", explode: true },
        })
        .returns(text()),
    });
    const client = createClient(api, {
      baseUrl: "https://example.test",
      fetch: async (request) => {
        requests.push(request);
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    });
    await client.read({
      params: { coords: [10, 20] },
      query: { tags: ["a", "b"], filter: { state: "open" } },
      headers: { "x-flags": { dry: true, force: false } },
    });
    expect(requests[0]!.url).toBe(
      "https://example.test/things/.10.20?tags=a%7Cb&filter%5Bstate%5D=open",
    );
    expect(requests[0]!.headers.get("x-flags")).toBe("dry=true,force=false");
  });
  it("should serialize special query values consistently in scalar and array positions", async () => {
    let request: Request | undefined;
    await createFetch({
      fetch: async (value) => {
        request = value;
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    })({
      url: "https://example.test/search",
      query: {
        scalarNull: null,
        arrayNull: [null],
        scalarUndefined: undefined,
        arrayUndefined: [undefined],
        scalarNaN: Number.NaN,
        arrayNaN: [Number.NaN],
        mixed: [null, true, false, 0, "", Number.NaN],
        nested: { nullable: null, truthy: true, zero: 0, empty: "" },
      },
      response: text(),
    });

    expect(request?.url).toBe(
      "https://example.test/search?scalarNull=null&arrayNull=null&scalarNaN=NaN&arrayNaN=NaN&mixed=null&mixed=true&mixed=false&mixed=0&mixed=&mixed=NaN&nullable=null&truthy=true&zero=0&empty=",
    );
  });
  it("should validate and transform parameters given validators when calling", async () => {
    const validator = {
      safeParse: vi.fn((value: unknown) => ({
        success: true as const,
        data: `checked-${String(value)}`,
      })),
    };
    let request: Request | undefined;
    const api = defineApi({
      read: get("/things/{id}")
        .params<{ id: string }>({ id: validator })
        .query<{ q: string }>({ q: { validator } })
        .headers<{ "x-mode": string }>({ "x-mode": { validator } })
        .returns(text()),
    });
    const result = await createClient(api, {
      baseUrl: "https://example.test",
      fetch: async (value) => {
        request = value;
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    }).read({ params: { id: "7" }, query: { q: "open" }, headers: { "x-mode": "fast" } });
    expect(result).toMatchObject({ ok: true });
    expect(request?.url).toBe("https://example.test/things/checked-7?q=checked-open");
    expect(request?.headers.get("x-mode")).toBe("checked-fast");
    expect(validator.safeParse).toHaveBeenCalledTimes(3);
  });
});
