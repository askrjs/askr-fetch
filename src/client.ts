import type {
  AnyEndpointDescriptor,
  ApiDefinition,
  ClientOptions,
  Codec,
  EndpointDescriptor,
  FailureKind,
  FailureResult,
  FetchResult,
  HttpResult,
  InferCodec,
  ParameterMap,
  ParameterSpec,
  RequestContext,
  SuccessResult,
} from "./types";

const media = (response: Response) =>
  response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
const compatible = (codec: Codec, type: string | null) =>
  codec.kind === "empty" ||
  codec.kind === "blob" ||
  codec.kind === "arrayBuffer" ||
  codec.kind === "stream" ||
  (!!type &&
    codec.mediaTypes.some(
      (expected) =>
        expected === "*/*" ||
        expected === type ||
        (expected === "text/*" && type.startsWith("text/")) ||
        (expected === "+json" && type.endsWith("+json")),
    ));
async function decode(response: Response, codec: Codec): Promise<unknown> {
  const type = media(response);
  const selected = codec.kind === "content" ? codec.variants?.[type ?? ""] : codec;
  if (!selected || !compatible(selected, type))
    throw new TypeError(
      `Cannot decode ${type ?? "missing content type"} as ${codec.mediaTypes.join(", ") || "empty"}`,
    );
  let value: unknown;
  switch (selected.kind) {
    case "empty":
      if ((await response.clone().arrayBuffer()).byteLength)
        throw new TypeError("Expected an empty response body");
      return undefined;
    case "json":
      value = await response.json();
      break;
    case "text":
      value = await response.text();
      break;
    case "urlEncoded":
      value = new URLSearchParams(await response.text());
      break;
    case "multipart":
      value = await response.formData();
      break;
    case "blob":
      value = await response.blob();
      break;
    case "arrayBuffer":
      value = await response.arrayBuffer();
      break;
    case "stream":
      return response.body;
    default:
      throw new TypeError("Invalid codec");
  }
  if (selected.validator) {
    const parsed = selected.validator.safeParse(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }
  return value;
}
function encode(value: unknown, codec: Codec, headers: Headers): BodyInit | undefined {
  if (codec.validator) {
    const parsed = codec.validator.safeParse(value);
    if (!parsed.success) throw parsed.error;
    value = parsed.data;
  }
  switch (codec.kind) {
    case "empty":
      return undefined;
    case "json":
      headers.set("content-type", "application/json");
      return JSON.stringify(value);
    case "text":
      headers.set("content-type", "text/plain;charset=UTF-8");
      return String(value);
    case "urlEncoded":
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      return value as URLSearchParams;
    case "multipart":
      return value as FormData;
    case "blob":
    case "arrayBuffer":
    case "stream":
      return value as BodyInit;
    case "content": {
      const [type, selected] = Object.entries(codec.variants ?? {})[0] ?? [];
      if (!selected) throw new TypeError("content() has no variants");
      const body = encode(value, selected, headers);
      if (selected.kind !== "multipart") headers.set("content-type", type);
      return body;
    }
  }
}
const failure = (
  kind: FailureKind,
  error: unknown,
  url: string,
  response?: Response,
): FailureResult => ({
  ok: false,
  kind,
  status: response?.status ?? 0,
  error,
  headers: response?.headers ?? new Headers(),
  url,
  ...(response ? { response } : {}),
});
const entries = (value: unknown): [string, unknown][] =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
const values = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const encoded = (value: unknown) => encodeURIComponent(String(value));
function pathParameter(name: string, value: unknown, spec: ParameterSpec = {}): string {
  const style = spec.style ?? "simple";
  const explode = spec.explode ?? false;
  const object = entries(value);
  const array = Array.isArray(value);
  if (style === "label") {
    const parts = object.length
      ? object.flatMap(([k, v]) =>
          explode ? [`${encoded(k)}=${encoded(v)}`] : [encoded(k), encoded(v)],
        )
      : values(value).map(encoded);
    return `.${parts.join(explode ? "." : ",")}`;
  }
  if (style === "matrix") {
    if (object.length)
      return explode
        ? object.map(([k, v]) => `;${encoded(k)}=${encoded(v)}`).join("")
        : `;${encoded(name)}=${object.flatMap(([k, v]) => [encoded(k), encoded(v)]).join(",")}`;
    if (array && explode)
      return values(value)
        .map((v) => `;${encoded(name)}=${encoded(v)}`)
        .join("");
    return `;${encoded(name)}=${values(value).map(encoded).join(",")}`;
  }
  if (style !== "simple") throw new TypeError(`Unsupported path parameter style: ${style}`);
  if (object.length)
    return object
      .flatMap(([k, v]) => (explode ? [`${encoded(k)}=${encoded(v)}`] : [encoded(k), encoded(v)]))
      .join(",");
  return values(value).map(encoded).join(",");
}
function queryParameter(
  output: URLSearchParams,
  name: string,
  value: unknown,
  spec: ParameterSpec = {},
): void {
  const style = spec.style ?? "form";
  const explode = spec.explode ?? true;
  const object = entries(value).filter(([, item]) => item !== undefined);
  const array = Array.isArray(value);
  const emptyArray = array && value.length === 0;
  const items = values(value)
    .filter((item) => item !== undefined)
    .map(String);
  const append = (key: string, item: unknown) => output.append(key, String(item));
  if (style === "deepObject") {
    if (!object.length) throw new TypeError(`deepObject query parameter ${name} must be an object`);
    for (const [key, item] of object) append(`${name}[${key}]`, item);
    return;
  }
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    if (!array) throw new TypeError(`${style} query parameter ${name} must be an array`);
    if (items.length || emptyArray)
      append(name, items.join(style === "spaceDelimited" ? " " : "|"));
    return;
  }
  if (style !== "form") throw new TypeError(`Unsupported query parameter style: ${style}`);
  if (object.length) {
    if (explode) for (const [key, item] of object) append(key, item);
    else append(name, object.flatMap(([key, item]) => [key, String(item)]).join(","));
    return;
  }
  if (array && explode) for (const item of items) append(name, item);
  else if (items.length || emptyArray) append(name, items.join(","));
}
function headerParameter(value: unknown, spec: ParameterSpec = {}): string {
  if ((spec.style ?? "simple") !== "simple")
    throw new TypeError(`Unsupported header parameter style: ${spec.style}`);
  const object = entries(value);
  if (object.length)
    return object
      .flatMap(([key, item]) => (spec.explode ? [`${key}=${String(item)}`] : [key, item]))
      .join(",");
  return values(value).join(",");
}
const parameterSpec = (map: ParameterMap | undefined, name: string): ParameterSpec => {
  const value = map?.[name];
  return value && typeof value === "object" && !("safeParse" in value) ? value : {};
};
const parameterValue = (map: ParameterMap | undefined, name: string, value: unknown): unknown => {
  const definition = map?.[name];
  const validator =
    definition && typeof definition === "object" && "safeParse" in definition
      ? definition
      : definition?.validator;
  if (!validator) return value;
  const parsed = validator.safeParse(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
};

/** A one-off, untyped request description accepted by {@link createFetch}'s returned function. */
export interface AdHocCall {
  url: string;
  method?: string;
  headers?: HeadersInit;
  query?: Record<string, unknown>;
  querySpec?: ParameterMap;
  body?: unknown;
  bodyCodec?: Codec;
  response?: Codec;
  responses?: Readonly<Record<number, Codec>>;
  errors?: Partial<Record<number | "default", Codec>>;
  signal?: AbortSignal;
  timeout?: number;
  endpoint?: EndpointDescriptor;
  operationId?: string;
}
/**
 * Creates a low-level fetch function that builds a `Request` from an {@link AdHocCall},
 * runs it through the configured middleware chain, and decodes the response with the
 * matching codec. Used internally by {@link createClient}, and usable directly for
 * requests without a full {@link EndpointDescriptor}.
 */
export function createFetch(options: ClientOptions = {}) {
  return async (call: AdHocCall): Promise<FetchResult> => {
    let url = `${options.baseUrl?.replace(/\/$/, "") ?? ""}${call.url}`;
    const headers = new Headers(options.headers);
    new Headers(call.headers).forEach((v, k) => headers.set(k, v));
    try {
      if (call.query) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(call.query))
          if (value !== undefined)
            queryParameter(
              query,
              key,
              parameterValue(call.querySpec, key, value),
              parameterSpec(call.querySpec, key),
            );
        const rendered = query.toString();
        if (rendered) url += `${url.includes("?") ? "&" : "?"}${rendered}`;
      }
    } catch (error) {
      return failure("request", error, url);
    }
    let body: BodyInit | undefined;
    try {
      if (call.bodyCodec) body = encode(call.body, call.bodyCodec, headers);
    } catch (error) {
      return failure("request", error, url);
    }
    const timeout = call.timeout ?? options.timeout;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(call.signal?.reason);
    call.signal?.addEventListener("abort", abort, { once: true });
    if (call.signal?.aborted) abort();
    if (timeout !== undefined)
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Timed out", "TimeoutError"));
      }, timeout);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      call.signal?.removeEventListener("abort", abort);
    };
    if (controller.signal.aborted) {
      cleanup();
      return failure("abort", controller.signal.reason, url);
    }
    let request: Request;
    try {
      request = new Request(url, {
        method: call.method ?? "GET",
        headers,
        body,
        credentials: options.credentials,
        signal: controller.signal,
        ...(body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
      });
    } catch (error) {
      cleanup();
      return failure("request", error, url);
    }
    const transport = options.fetch ?? globalThis.fetch;
    const terminal = async (context: RequestContext): Promise<FetchResult> => {
      let response: Response;
      try {
        response = await transport(context.request);
      } catch (error) {
        return failure(
          timedOut ? "timeout" : call.signal?.aborted ? "abort" : "network",
          error,
          url,
        );
      }
      const codec = response.ok
        ? (call.responses?.[response.status] ?? call.response)
        : (call.errors?.[response.status] ?? call.errors?.default);
      if (!codec)
        return failure(
          "decode",
          new TypeError(`No codec for status ${response.status}`),
          url,
          response,
        );
      try {
        const data = await decode(response.clone(), codec);
        return response.ok
          ? {
              ok: true,
              kind: "success",
              status: response.status,
              data,
              mediaType: media(response),
              headers: response.headers,
              url: response.url || url,
              response,
            }
          : {
              ok: false,
              kind: "http",
              status: response.status,
              error: data,
              mediaType: media(response),
              headers: response.headers,
              url: response.url || url,
              response,
            };
      } catch (error) {
        return failure("decode", error, url, response);
      }
    };
    const middleware = options.middleware ?? [];
    const dispatch = (index: number, context: RequestContext): Promise<FetchResult> =>
      index === middleware.length
        ? terminal(context)
        : Promise.resolve().then(() =>
            middleware[index]!(context, (next = context) => dispatch(index + 1, next)),
          );
    try {
      return await dispatch(
        0,
        Object.freeze({
          request,
          endpoint: call.endpoint,
          operationId: call.operationId,
          security: call.endpoint?.security,
          attempt: 1,
          ...(body === undefined ? {} : { replayableBody: !(body instanceof ReadableStream) }),
          ...(timeout === undefined ? {} : { deadline: Date.now() + timeout }),
        }),
      );
    } catch (error) {
      return failure("middleware", error, url);
    } finally {
      cleanup();
    }
  };
}

type InputParts<D> =
  D extends EndpointDescriptor<infer P, infer Q, infer H, infer B, any, any>
    ? { params: P; query: Q; headers: H; body: B }
    : never;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Container<K extends string, T, Always extends boolean = false> = [T] extends [undefined]
  ? {}
  : Always extends true
    ? { [P in K]: T }
    : RequiredKeys<T> extends never
      ? { [P in K]?: T }
      : { [P in K]: T };
type EndpointInput<D extends AnyEndpointDescriptor> = Container<
  "params",
  InputParts<D>["params"],
  true
> &
  Container<"query", InputParts<D>["query"]> &
  Container<"headers", InputParts<D>["headers"]> &
  Container<"body", InputParts<D>["body"], true> & { signal?: AbortSignal; timeout?: number };
type Successes<D> =
  D extends EndpointDescriptor<any, any, any, any, infer R, any>
    ? { [S in keyof R & number]: SuccessResult<InferCodec<R[S]>, S> }[keyof R & number]
    : never;
type Errors<D> =
  D extends EndpointDescriptor<any, any, any, any, any, infer E>
    ?
        | {
            [S in Exclude<keyof E, "default"> & number]: HttpResult<
              InferCodec<NonNullable<E[S]>>,
              S
            >;
          }[Exclude<keyof E, "default"> & number]
        | ("default" extends keyof E
            ? HttpResult<InferCodec<NonNullable<E["default"]>>, number>
            : never)
    : never;
/** The possible results of calling a typed client method for endpoint descriptor `D`. */
export type ClientResult<D extends AnyEndpointDescriptor> =
  | Successes<D>
  | Errors<D>
  | FailureResult;
type ClientMethod<D extends AnyEndpointDescriptor> =
  RequiredKeys<EndpointInput<D>> extends never
    ? (input?: EndpointInput<D>) => Promise<ClientResult<D>>
    : (input: EndpointInput<D>) => Promise<ClientResult<D>>;
/** A fully-typed client for an {@link ApiDefinition}, with one method per endpoint. */
export type ApiClient<A extends ApiDefinition> = Readonly<{
  [K in keyof A["endpoints"]]: ClientMethod<A["endpoints"][K]>;
}>;
/**
 * Builds a typed {@link ApiClient} from an {@link ApiDefinition}. Each endpoint becomes
 * a method that fills in the path, query, header, and body parameters, executes the
 * request via {@link createFetch}, and returns a {@link ClientResult}.
 */
export function createClient<A extends ApiDefinition>(
  api: A,
  options: ClientOptions = {},
): ApiClient<A> {
  const execute = createFetch(options);
  const methods = Object.fromEntries(
    Object.entries(api.endpoints).map(([id, endpoint]) => [
      id,
      async (input: Record<string, any> = {}) => {
        let path = endpoint.path;
        try {
          for (const name of path.matchAll(/\{([^}]+)\}/g)) {
            const key = name[1]!;
            const value = input.params?.[key];
            if (value === undefined)
              return failure("request", new TypeError(`Missing path parameter: ${key}`), path);
            path = path.replace(
              name[0],
              pathParameter(
                key,
                parameterValue(endpoint.params, key, value),
                parameterSpec(endpoint.params, key),
              ),
            );
          }
        } catch (error) {
          return failure("request", error, path);
        }
        const extras = Object.keys(input.params ?? {}).filter(
          (key) => !endpoint.path.includes(`{${key}}`),
        );
        if (extras.length)
          return failure("request", new TypeError(`Unexpected path parameter: ${extras[0]}`), path);
        const headers = new Headers();
        try {
          for (const [key, value] of Object.entries(input.headers ?? {}))
            if (value !== undefined)
              headers.set(
                key,
                headerParameter(
                  parameterValue(endpoint.headers, key, value),
                  parameterSpec(endpoint.headers, key),
                ),
              );
        } catch (error) {
          return failure("request", error, path);
        }
        return execute({
          url: path,
          method: endpoint.method,
          headers,
          query: input.query,
          querySpec: endpoint.query,
          body: input.body,
          bodyCodec: endpoint.body,
          responses: endpoint.responses,
          errors: endpoint.errors,
          signal: input.signal,
          timeout: input.timeout,
          endpoint,
          operationId: id,
        });
      },
    ]),
  ) as ApiClient<A>;
  return Object.freeze(methods);
}
/** An `Error` thrown by {@link unwrap} that wraps a failed (non-`ok`) {@link FetchResult}. */
export class FetchError extends Error {
  constructor(readonly result: Exclude<FetchResult, { ok: true }>) {
    super(`Fetch failed: ${result.kind}`);
    this.name = "FetchError";
  }
}
/**
 * Returns the data of a successful {@link FetchResult}, or throws a {@link FetchError}
 * wrapping the result if it was not `ok`.
 */
export function unwrap<T>(result: FetchResult<T>): T {
  if (!result.ok) throw new FetchError(result);
  return result.data;
}
