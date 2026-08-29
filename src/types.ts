/**
 * A minimal schema-validation contract, compatible with `safeParse` methods
 * that report failures through either `error` or `issues`.
 */
export interface Validator<T = unknown> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown; readonly issues?: unknown }
    | { readonly success: false; readonly error?: unknown; readonly issues: unknown };
}
/** Infers the parsed output type `T` from a {@link Validator}. */
export type InferValidator<V> = V extends { safeParse(value: unknown): infer Result }
  ? Extract<Result, { readonly success: true }> extends { readonly data: infer T }
    ? T
    : never
  : never;

/**
 * Describes how a request or response body is serialized/deserialized:
 * which wire format (`kind`), which media types it matches, and optionally
 * a {@link Validator} to parse/validate the decoded value.
 */
export interface Codec<T = unknown> {
  readonly kind:
    | "json"
    | "text"
    | "urlEncoded"
    | "multipart"
    | "blob"
    | "arrayBuffer"
    | "stream"
    | "empty"
    | "content";
  readonly mediaTypes: readonly string[];
  readonly validator?: Validator<T>;
  /** For `kind: "content"`, the per-media-type codec variants. */
  readonly variants?: Readonly<Record<string, Codec<unknown>>>;
}
/** Infers the decoded value type `T` from a {@link Codec}. */
export type InferCodec<C> = C extends Codec<infer T> ? T : never;
/** The set of HTTP methods supported by endpoint descriptors. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
/** OpenAPI-style serialization styles for path, query, and header parameters. */
export type ParameterStyle =
  | "simple"
  | "label"
  | "matrix"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";
/** Serialization and validation settings for a single path, query, or header parameter. */
export interface ParameterSpec<T = unknown> {
  readonly validator?: Validator<T>;
  readonly style?: ParameterStyle;
  readonly explode?: boolean;
}
/**
 * Maps parameter names to either a bare {@link Validator} or a full
 * {@link ParameterSpec} describing serialization and validation.
 */
export type ParameterMap = Readonly<Record<string, Validator<unknown> | ParameterSpec | undefined>>;

/** Describes a single API endpoint: its method, path, parameters, body, and possible responses. */
export interface EndpointDescriptor<
  P = undefined,
  Q = undefined,
  H = undefined,
  B = undefined,
  R extends Record<number, Codec> = Record<number, Codec>,
  E extends Partial<Record<number | "default", Codec>> = Partial<Record<number | "default", Codec>>,
> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params?: ParameterMap;
  readonly query?: ParameterMap;
  readonly headers?: ParameterMap;
  readonly body?: Codec;
  readonly responses: Readonly<R>;
  readonly errors: Readonly<E>;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly operationId?: string;
  readonly __input?: { params: P; query: Q; headers: H; body: B };
}
/** An {@link EndpointDescriptor} with its type parameters erased, for use in generic contexts. */
export type AnyEndpointDescriptor = EndpointDescriptor<any, any, any, any, any, any>;
/** API-level (rather than per-endpoint) metadata, such as servers and security schemes. */
export interface ApiMetadata {
  readonly servers?: readonly (string | { readonly url: string })[];
  readonly tags?: readonly unknown[];
  readonly securitySchemes?: Readonly<Record<string, unknown>>;
}
/** A named collection of endpoints plus optional API metadata, as produced by {@link defineApi}. */
export interface ApiDefinition<
  E extends Record<string, AnyEndpointDescriptor> = Record<string, AnyEndpointDescriptor>,
> {
  readonly endpoints: E;
  readonly metadata?: ApiMetadata;
}

/** A successful (2xx) fetch outcome, carrying the decoded response data. */
export type SuccessResult<T = unknown, S extends number = number> = {
  ok: true;
  kind: "success";
  status: S;
  data: T;
  mediaType: string | null;
  headers: Headers;
  url: string;
  response: Response;
};
/** A non-2xx fetch outcome where the server responded with a decodable error body. */
export type HttpResult<T = unknown, S extends number = number> = {
  ok: false;
  kind: "http";
  status: S;
  error: T;
  mediaType: string | null;
  headers: Headers;
  url: string;
  response: Response;
};
/** Categorizes why a fetch could not produce an {@link HttpResult} or {@link SuccessResult}. */
export type FailureKind = "request" | "network" | "timeout" | "abort" | "decode" | "middleware";
/** A fetch outcome that failed before or independently of receiving a decodable HTTP response. */
export type FailureResult = {
  ok: false;
  kind: FailureKind;
  status: number;
  error: unknown;
  headers: Headers;
  url: string;
  response?: Response;
};
/** The outcome of a fetch call: success, an HTTP-level error, or another kind of failure. */
export type FetchResult<T = unknown> = SuccessResult<T> | HttpResult<T> | FailureResult;

/** The mutable-by-replacement state threaded through the middleware chain for a single request. */
export interface RequestContext {
  readonly request: Request;
  readonly endpoint?: AnyEndpointDescriptor;
  readonly operationId?: string;
  readonly security?: AnyEndpointDescriptor["security"];
  /** 1 on the first attempt, incremented by middleware (e.g. {@link retry}) on subsequent attempts. */
  readonly attempt: number;
  /** Whether a body was encoded from a replayable value; streaming bodies set this to `false`. */
  readonly replayableBody?: boolean;
  /** Absolute timestamp (ms since epoch) by which the request must complete, if a timeout is set. */
  readonly deadline?: number;
}
/** Invokes the next middleware in the chain, optionally passing a replacement context. */
export type Next = (context?: RequestContext) => Promise<FetchResult>;
/** A function that can inspect/replace the request context and/or the result of calling `next`. */
export type Middleware = (context: RequestContext, next: Next) => Promise<FetchResult>;
/** Options controlling how a {@link createClient} or {@link createFetch} client makes requests. */
export interface ClientOptions {
  baseUrl?: string;
  /** Custom transport, defaulting to the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Middleware chain applied to every request, in order. */
  middleware?: readonly Middleware[];
}
