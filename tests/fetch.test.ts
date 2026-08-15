import { describe, expect, it, vi } from "vitest";
import {
  arrayBuffer,
  content,
  createClient,
  createFetch,
  defineApi,
  del,
  empty,
  get,
  json,
  post,
  text,
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
  it.each(["status", "network"] as const)(
    "should retry replayable PUT bodies after a %s failure",
    async (failure) => {
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
        method: "PUT",
        headers: { "x-request": "preserved" },
        body: { name: "updated" },
        bodyCodec: json(),
        response: text(),
        errors: { 503: text() },
      });

      expect(result).toMatchObject({ ok: true, data: "ok" });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(bodies).toEqual(['{"name":"updated"}', '{"name":"updated"}']);
      expect(headers).toEqual([
        "application/json|preserved",
        "application/json|preserved",
      ]);
    },
  );
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
      },
      response: text(),
    });

    expect(request?.url).toBe(
      "https://example.test/search?scalarNull=null&arrayNull=null&scalarNaN=NaN&arrayNaN=NaN",
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
