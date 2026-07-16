import { describe, expect, it, vi } from "vitest";
import { arrayBuffer, createClient, createFetch, defineApi, del, empty, get, json, post, text } from "../src";
import { bearerAuth, logging, retry, telemetry } from "../src/middleware";

describe("fetch contracts", () => {
  it("should infer required path values given a brace parameter when calling", async () => {
    const transport = vi.fn(async (request: Request) => new Response(JSON.stringify({ url: request.url }), { headers: { "content-type": "application/json" } }));
    const client = createClient(defineApi({ getUser: get("/users/{id}").params<{ id: string | number }>().returns(json<{ url: string }>()) }), { baseUrl: "https://example.test", fetch: transport });
    // @ts-expect-error path params are required by the operation contract
    expect(await client.getUser()).toMatchObject({ ok: false, kind: "request" });
    expect(await client.getUser({ params: { id: 7 } })).toMatchObject({ ok: true, data: { url: "https://example.test/users/7" } });
  });
  it("should reject non-brace paths given colon wildcard or malformed syntax when defining", () => {
    for (const path of ["/users/:id", "/files/*", "/users/{", "/{id}/{id}"]) expect(() => get(path)).toThrow();
  });
  it("should reject missing and extra declarations given path params when configuring", () => {
    expect(() => get("/{id}").params({})).toThrow(); expect(() => get("/{id}").params({ id: undefined, extra: undefined })).toThrow();
  });
  it("should return every failure kind given failures when executing", async () => {
    const network = createFetch({ fetch: async () => { throw new Error("offline"); } });
    expect(await network({ url: "https://x.test", response: text() })).toMatchObject({ kind: "network" });
    const decode = createFetch({ fetch: async () => new Response("no", { headers: { "content-type": "text/plain" } }) });
    expect(await decode({ url: "https://x.test", response: json() })).toMatchObject({ kind: "decode" });
    const http = createFetch({ fetch: async () => new Response("bad", { status: 400, headers: { "content-type": "text/plain" } }) });
    expect(await http({ url: "https://x.test", errors: { 400: text() } })).toMatchObject({ kind: "http", error: "bad" });
    const middleware = createFetch({ middleware: [async () => { throw new Error("bad"); }] });
    expect(await middleware({ url: "https://x.test", response: text() })).toMatchObject({ kind: "middleware" });
  });
  it("should distinguish timeout from caller abort given cancellation when executing", async () => {
    const hanging = async (_request: Request) => new Promise<Response>((_, reject) => _request.signal.addEventListener("abort", () => reject(_request.signal.reason)));
    expect(await createFetch({ fetch: hanging, timeout: 5 })({ url: "https://x.test", response: text() })).toMatchObject({ kind: "timeout" });
    const controller = new AbortController(); const pending = createFetch({ fetch: hanging })({ url: "https://x.test", response: text(), signal: controller.signal }); controller.abort(); expect(await pending).toMatchObject({ kind: "abort" });
  });
  it("should decode codecs given actual compatible content types when responding", async () => {
    const execute = createFetch({ fetch: async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/octet-stream" } }) });
    const result = await execute({ url: "https://x.test", response: arrayBuffer() }); expect(result.ok && [...new Uint8Array(result.data as ArrayBuffer)]).toEqual([1, 2]);
    expect(() => del("/x").returns(204, json())).toThrow(); expect(del("/x").returns(204, empty())).toBeDefined();
  });
  it("should execute middleware outward given declaration order when responding", async () => {
    const events: string[] = []; const layer = (name: string) => async (context: any, next: any) => { events.push(`${name}:in`); const result = await next(context); events.push(`${name}:out`); return result; };
    await createFetch({ middleware: [layer("a"), layer("b")], fetch: async () => new Response("ok", { headers: { "content-type": "text/plain" } }) })({ url: "https://x.test", response: text() });
    expect(events).toEqual(["a:in", "b:in", "b:out", "a:out"]);
  });
  it("should apply auth retry redaction and telemetry given polished middleware when executing", async () => {
    const logs: Record<string, unknown>[] = []; const spans: string[] = []; let calls = 0;
    const execute = createFetch({ middleware: [bearerAuth({ token: "secret" }), logging({ log: (e) => logs.push(e) }), telemetry({ start: () => spans.push("start"), end: () => spans.push("end") }), retry({ attempts: 2, delay: () => 0 })], fetch: async (request) => { calls++; expect(request.headers.get("authorization")).toBe("Bearer secret"); return new Response(calls === 1 ? "later" : "ok", { status: calls === 1 ? 503 : 200, headers: { "content-type": "text/plain", "retry-after": "0" } }); } });
    expect(await execute({ url: "https://x.test", response: text(), errors: { 503: text() } })).toMatchObject({ ok: true }); expect(calls).toBe(2); expect(JSON.stringify(logs)).not.toContain("secret"); expect(spans).toEqual(["start", "end"]);
  });
  it("should freeze builders clients and descriptors given an API when constructed", () => {
    const api = defineApi({ create: post("/x").body(json()).returns(201, json()), read: get("/x").returns(text()) }); expect(Object.isFrozen(api.endpoints.create)).toBe(true); expect(Object.isFrozen(createClient(api))).toBe(true);
  });
  it("should decode by literal status given multiple success responses when calling", async () => {
    const api = defineApi({ create: post("/jobs").headers<{ "x-mode"?: string }>({ "x-mode": { style: "simple" } }).body(json<{ name: string }>()).returns(201, json<{ id: string }>()).returns(202, text()).errors({ 409: json<{ title: string }>(), default: text() }) });
    const client = createClient(api, { baseUrl: "https://example.test", fetch: async (request) => request.headers.get("x-mode") === "async" ? new Response("queued", { status: 202, headers: { "content-type": "text/plain" } }) : new Response(JSON.stringify({ id: "job-1" }), { status: 201, headers: { "content-type": "application/json" } }) });
    const created = await client.create({ body: { name: "deploy" }, headers: { "x-mode": "sync" } });
    expect(created).toMatchObject({ ok: true, status: 201, data: { id: "job-1" } });
    const queued = await client.create({ body: { name: "deploy" }, headers: { "x-mode": "async" } });
    expect(queued).toMatchObject({ ok: true, status: 202, data: "queued" });
    if (created.ok && created.status === 201) created.data.id satisfies string;
    // @ts-expect-error body is required by this operation
    void client.create();
  });
  it("should serialize OpenAPI styles given structured parameters when calling", async () => {
    const requests: Request[] = [];
    const api = defineApi({ read: get("/things/{coords}")
      .params<{ coords: number[] }>({ coords: { style: "label", explode: true } })
      .query<{ tags: string[]; filter: { state: string } }>({ tags: { style: "pipeDelimited", explode: false }, filter: { style: "deepObject", explode: true } })
      .headers<{ "x-flags": { dry: boolean; force: boolean } }>({ "x-flags": { style: "simple", explode: true } })
      .returns(text()) });
    const client = createClient(api, { baseUrl: "https://example.test", fetch: async (request) => { requests.push(request); return new Response("ok", { headers: { "content-type": "text/plain" } }); } });
    await client.read({ params: { coords: [10, 20] }, query: { tags: ["a", "b"], filter: { state: "open" } }, headers: { "x-flags": { dry: true, force: false } } });
    expect(requests[0]!.url).toBe("https://example.test/things/.10.20?tags=a%7Cb&filter%5Bstate%5D=open");
    expect(requests[0]!.headers.get("x-flags")).toBe("dry=true,force=false");
  });
});
