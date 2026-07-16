import type { ApiDefinition, ClientOptions, Codec, EndpointDescriptor, FailureKind, FetchResult, RequestContext } from "./types";

const media = (response: Response) => response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
const compatible = (codec: Codec, type: string | null) => codec.kind === "empty" || codec.kind === "blob" || codec.kind === "arrayBuffer" || codec.kind === "stream" || !!type && codec.mediaTypes.some((expected) => expected === "*/*" || expected === type || expected === "text/*" && type.startsWith("text/") || expected === "+json" && type.endsWith("+json"));
async function decode(response: Response, codec: Codec): Promise<unknown> {
  const type = media(response); const selected = codec.kind === "content" ? codec.variants?.[type ?? ""] : codec;
  if (!selected || !compatible(selected, type)) throw new TypeError(`Cannot decode ${type ?? "missing content type"} as ${codec.mediaTypes.join(", ") || "empty"}`);
  let value: unknown;
  switch (selected.kind) {
    case "empty": if ((await response.clone().arrayBuffer()).byteLength) throw new TypeError("Expected an empty response body"); return undefined;
    case "json": value = await response.json(); break; case "text": value = await response.text(); break;
    case "urlEncoded": value = new URLSearchParams(await response.text()); break; case "multipart": value = await response.formData(); break;
    case "blob": value = await response.blob(); break; case "arrayBuffer": value = await response.arrayBuffer(); break; case "stream": return response.body;
    default: throw new TypeError("Invalid codec");
  }
  if (selected.validator) { const parsed = selected.validator.safeParse(value); if (!parsed.success) throw parsed.error; return parsed.data; }
  return value;
}
function encode(value: unknown, codec: Codec, headers: Headers): BodyInit | undefined {
  if (codec.validator) { const parsed = codec.validator.safeParse(value); if (!parsed.success) throw parsed.error; value = parsed.data; }
  switch (codec.kind) {
    case "empty": return undefined; case "json": headers.set("content-type", "application/json"); return JSON.stringify(value);
    case "text": headers.set("content-type", "text/plain;charset=UTF-8"); return String(value); case "urlEncoded": headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8"); return value as URLSearchParams;
    case "multipart": return value as FormData; case "blob": case "arrayBuffer": case "stream": return value as BodyInit;
    case "content": { const [type, selected] = Object.entries(codec.variants ?? {})[0] ?? []; if (!selected) throw new TypeError("content() has no variants"); headers.set("content-type", type); return encode(value, selected, headers); }
  }
}
const failure = (kind: FailureKind, error: unknown, url: string, response?: Response): FetchResult => ({ ok: false, kind, status: response?.status ?? 0, error, headers: response?.headers ?? new Headers(), url, ...(response ? { response } : {}) });
function serialize(value: unknown): string { if (Array.isArray(value)) return value.map(String).join(","); if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, String(v)]).join(","); return String(value); }
export interface AdHocCall { url: string; method?: string; headers?: HeadersInit; query?: Record<string, unknown>; body?: unknown; bodyCodec?: Codec; response?: Codec; errors?: Partial<Record<number | "default", Codec>>; signal?: AbortSignal; timeout?: number; endpoint?: EndpointDescriptor; operationId?: string }
export function createFetch(options: ClientOptions = {}) {
  return async (call: AdHocCall): Promise<FetchResult> => {
    let url = `${options.baseUrl?.replace(/\/$/, "") ?? ""}${call.url}`; const headers = new Headers(options.headers); new Headers(call.headers).forEach((v, k) => headers.set(k, v));
    if (call.query) { const query = new URLSearchParams(); for (const [key, value] of Object.entries(call.query)) if (value !== undefined) query.set(key, serialize(value)); url += `${url.includes("?") ? "&" : "?"}${query}`; }
    let body: BodyInit | undefined; try { if (call.bodyCodec) body = encode(call.body, call.bodyCodec, headers); } catch (error) { return failure("request", error, url); }
    const timeout = call.timeout ?? options.timeout; const controller = new AbortController(); let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(call.signal?.reason); call.signal?.addEventListener("abort", abort, { once: true }); if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Timed out", "TimeoutError")); }, timeout);
    let request: Request; try { request = new Request(url, { method: call.method ?? "GET", headers, body, credentials: options.credentials, signal: controller.signal, ...(body instanceof ReadableStream ? { duplex: "half" } as RequestInit : {}) }); } catch (error) { if (timer) clearTimeout(timer); return failure("request", error, url); }
    const transport = options.fetch ?? globalThis.fetch; const terminal = async (context: RequestContext): Promise<FetchResult> => {
      let response: Response; try { response = await transport(context.request); } catch (error) { return failure(timedOut ? "timeout" : call.signal?.aborted ? "abort" : "network", error, url); }
      const codec = response.ok ? call.response : call.errors?.[response.status] ?? call.errors?.default;
      if (!codec) return failure("decode", new TypeError(`No codec for status ${response.status}`), url, response);
      try { const data = await decode(response.clone(), codec); return response.ok ? { ok: true, kind: "success", status: response.status, data, mediaType: media(response), headers: response.headers, url: response.url || url, response } : { ok: false, kind: "http", status: response.status, error: data, mediaType: media(response), headers: response.headers, url: response.url || url, response }; } catch (error) { return failure("decode", error, url, response); }
    };
    const middleware = options.middleware ?? []; const dispatch = (index: number, context: RequestContext): Promise<FetchResult> => index === middleware.length ? terminal(context) : Promise.resolve().then(() => middleware[index]!(context, (next = context) => dispatch(index + 1, next))).catch((error) => failure("middleware", error, url));
    try { return await dispatch(0, Object.freeze({ request, endpoint: call.endpoint, operationId: call.operationId, security: call.endpoint?.security, attempt: 1, ...(timeout === undefined ? {} : { deadline: Date.now() + timeout }) })); } finally { if (timer) clearTimeout(timer); call.signal?.removeEventListener("abort", abort); }
  };
}
type Input = { params?: Record<string, string | number>; query?: Record<string, unknown>; headers?: HeadersInit; body?: unknown; signal?: AbortSignal; timeout?: number };
export function createClient<A extends ApiDefinition>(api: A, options: ClientOptions = {}): Readonly<Record<keyof A["endpoints"], (input?: Input) => Promise<FetchResult>>> {
  const execute = createFetch(options); const methods = Object.fromEntries(Object.entries(api.endpoints).map(([id, endpoint]) => [id, async (input: Input = {}) => { let path = endpoint.path; for (const name of path.matchAll(/\{([^}]+)\}/g)) { const value = input.params?.[name[1]!]; if (value === undefined) return failure("request", new TypeError(`Missing path parameter: ${name[1]}`), path); path = path.replace(name[0], encodeURIComponent(String(value))); } const extras = Object.keys(input.params ?? {}).filter((key) => !endpoint.path.includes(`{${key}}`)); if (extras.length) return failure("request", new TypeError(`Unexpected path parameter: ${extras[0]}`), path); return execute({ url: path, method: endpoint.method, headers: input.headers, query: input.query, body: input.body, bodyCodec: endpoint.body, response: endpoint.responses[200] ?? endpoint.responses[Object.keys(endpoint.responses).map(Number)[0]!], errors: endpoint.errors, signal: input.signal, timeout: input.timeout, endpoint, operationId: id }); }])) as Record<keyof A["endpoints"], (input?: Input) => Promise<FetchResult>>;
  return Object.freeze(methods);
}
export class FetchError extends Error { constructor(readonly result: Exclude<FetchResult, { ok: true }>) { super(`Fetch failed: ${result.kind}`); this.name = "FetchError"; } }
export function unwrap<T>(result: FetchResult<T>): T { if (!result.ok) throw new FetchError(result); return result.data; }
