export interface Validator<T = unknown> { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }
export type InferValidator<V> = V extends Validator<infer T> ? T : never;

export interface Codec<T = unknown> {
  readonly kind: "json" | "text" | "urlEncoded" | "multipart" | "blob" | "arrayBuffer" | "stream" | "empty" | "content";
  readonly mediaTypes: readonly string[];
  readonly validator?: Validator<T>;
  readonly variants?: Readonly<Record<string, Codec<unknown>>>;
}
export type InferCodec<C> = C extends Codec<infer T> ? T : never;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export interface ParameterSpec<T = unknown> { readonly validator?: Validator<T>; readonly style?: string; readonly explode?: boolean }
export type ParameterMap = Readonly<Record<string, Validator<unknown> | ParameterSpec | undefined>>;
export interface EndpointDescriptor {
  readonly method: HttpMethod; readonly path: string;
  readonly params?: ParameterMap; readonly query?: ParameterMap; readonly headers?: ParameterMap;
  readonly body?: Codec; readonly responses: Readonly<Record<number, Codec>>;
  readonly errors: Readonly<Partial<Record<number | "default", Codec>>>; readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly operationId?: string;
}
export interface ApiMetadata { readonly servers?: readonly (string | { readonly url: string })[]; readonly tags?: readonly unknown[]; readonly securitySchemes?: Readonly<Record<string, unknown>> }
export interface ApiDefinition<E extends Record<string, EndpointDescriptor> = Record<string, EndpointDescriptor>> { readonly endpoints: E; readonly metadata?: ApiMetadata }

export type SuccessResult<T = unknown, S extends number = number> = { ok: true; kind: "success"; status: S; data: T; mediaType: string | null; headers: Headers; url: string; response: Response };
export type HttpResult<T = unknown, S extends number = number> = { ok: false; kind: "http"; status: S; error: T; mediaType: string | null; headers: Headers; url: string; response: Response };
export type FailureKind = "request" | "network" | "timeout" | "abort" | "decode" | "middleware";
export type FailureResult = { ok: false; kind: FailureKind; status: number; error: unknown; headers: Headers; url: string; response?: Response };
export type FetchResult<T = unknown> = SuccessResult<T> | HttpResult<T> | FailureResult;

export interface RequestContext { readonly request: Request; readonly endpoint?: EndpointDescriptor; readonly operationId?: string; readonly security?: EndpointDescriptor["security"]; readonly attempt: number; readonly deadline?: number }
export type Next = (context?: RequestContext) => Promise<FetchResult>;
export type Middleware = (context: RequestContext, next: Next) => Promise<FetchResult>;
export interface ClientOptions { baseUrl?: string; fetch?: (request: Request) => Promise<Response>; headers?: HeadersInit; credentials?: RequestCredentials; timeout?: number; middleware?: readonly Middleware[] }
