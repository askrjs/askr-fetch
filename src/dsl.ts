import type {
  AnyEndpointDescriptor,
  ApiDefinition,
  ApiMetadata,
  Codec,
  EndpointDescriptor,
  HttpMethod,
  ParameterMap,
} from "./types";

const PATH_NAME = /^[A-Za-z_$][\w$]*$/;
/**
 * Extracts the ordered list of `{param}` placeholder names from an endpoint path.
 *
 * @throws {TypeError} If the path uses colon/wildcard syntax, has malformed
 * `{...}` placeholders, or contains a duplicate parameter name.
 */
export function pathNames(path: string): string[] {
  if (path.includes(":") || path.includes("*")) throw new TypeError(`Invalid path syntax: ${path}`);
  const names: string[] = [];
  let index = 0;
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    const literal = path.slice(index, match.index);
    if (literal.includes("{") || literal.includes("}") || !PATH_NAME.test(match[1]!))
      throw new TypeError(`Malformed path parameter in ${path}`);
    if (names.includes(match[1]!)) throw new TypeError(`Duplicate path parameter: ${match[1]}`);
    names.push(match[1]!);
    index = (match.index ?? 0) + match[0].length;
  }
  if (path.slice(index).includes("{") || path.slice(index).includes("}"))
    throw new TypeError(`Malformed path parameter in ${path}`);
  return names;
}
type Responses = Record<number, Codec>;
type Errors = Partial<Record<number | "default", Codec>>;
type State = Omit<EndpointDescriptor, "responses" | "errors"> & {
  responses: Responses;
  errors: Errors;
};
const STATE = Symbol("endpoint-state");
/**
 * Fluent, immutable builder for describing a single endpoint's params, query,
 * headers, body, responses, errors, and security requirements. Each method
 * returns a new builder reflecting the added configuration; the accumulated
 * state is finalized into an {@link EndpointDescriptor} by {@link defineApi}.
 */
export interface EndpointBuilder<
  P = undefined,
  Q = undefined,
  H = undefined,
  B = undefined,
  R extends Responses = {},
  E extends Errors = {},
> {
  readonly [STATE]: State;
  params<T extends Record<string, unknown>>(spec?: ParameterMap): EndpointBuilder<T, Q, H, B, R, E>;
  query<T extends Record<string, unknown>>(spec?: ParameterMap): EndpointBuilder<P, T, H, B, R, E>;
  headers<T extends Record<string, unknown>>(
    spec?: ParameterMap,
  ): EndpointBuilder<P, Q, T, B, R, E>;
  body<C extends Codec>(
    codec: C,
  ): EndpointBuilder<P, Q, H, C extends Codec<infer T> ? T : never, R, E>;
  returns<C extends Codec>(codec: C): EndpointBuilder<P, Q, H, B, R & Record<200, C>, E>;
  returns<S extends number, C extends Codec>(
    status: S,
    codec: C,
  ): EndpointBuilder<P, Q, H, B, R & Record<S, C>, E>;
  errors<T extends Errors>(spec: T): EndpointBuilder<P, Q, H, B, R, E & T>;
  security(
    requirements: readonly Readonly<Record<string, readonly string[]>>[],
  ): EndpointBuilder<P, Q, H, B, R, E>;
}
const needsEmpty = (state: State, status: number) =>
  status === 204 || status === 205 || state.method === "HEAD";
function build<
  P = undefined,
  Q = undefined,
  H = undefined,
  B = undefined,
  R extends Responses = {},
  E extends Errors = {},
>(state: State): EndpointBuilder<P, Q, H, B, R, E> {
  const update = (next: Partial<State>) => build({ ...state, ...next });
  const value = {
    [STATE]: state,
    params(spec?: ParameterMap) {
      const names = pathNames(state.path);
      if (
        spec &&
        (Object.keys(spec).some((k) => !names.includes(k)) || names.some((k) => !(k in spec)))
      )
        throw new TypeError(`Path params must exactly match ${names.join(", ")}`);
      return update({ params: spec ?? Object.fromEntries(names.map((name) => [name, undefined])) });
    },
    query(spec: ParameterMap = {}) {
      return update({ query: spec });
    },
    headers(spec: ParameterMap = {}) {
      return update({ headers: spec });
    },
    body(value: Codec) {
      return update({ body: value });
    },
    returns(statusOrCodec: number | Codec, maybeCodec?: Codec) {
      const status = typeof statusOrCodec === "number" ? statusOrCodec : 200;
      const responseCodec = typeof statusOrCodec === "number" ? maybeCodec! : statusOrCodec;
      if (status < 200 || status > 299) throw new TypeError("returns() accepts only 2xx statuses");
      if (needsEmpty(state, status) && responseCodec.kind !== "empty")
        throw new TypeError(`${state.method} ${status} requires empty()`);
      return update({ responses: { ...state.responses, [status]: responseCodec } });
    },
    errors(spec: Errors) {
      for (const key of Object.keys(spec))
        if (key !== "default" && Number(key) >= 200 && Number(key) <= 299)
          throw new TypeError("errors() accepts only non-2xx statuses or default");
      return update({ errors: { ...state.errors, ...spec } });
    },
    security(security: State["security"]) {
      return update({ security });
    },
  };
  return Object.freeze(value) as EndpointBuilder<P, Q, H, B, R, E>;
}
const method = (value: HttpMethod) => (path: string) => {
  const names = pathNames(path);
  return build({
    method: value,
    path,
    params: names.length ? Object.fromEntries(names.map((name) => [name, undefined])) : undefined,
    responses: {},
    errors: {},
  });
};
/** Starts building a GET endpoint at the given path. */
export const get = method("GET");
/** Starts building a POST endpoint at the given path. */
export const post = method("POST");
/** Starts building a PUT endpoint at the given path. */
export const put = method("PUT");
/** Starts building a PATCH endpoint at the given path. */
export const patch = method("PATCH");
/** Starts building a DELETE endpoint at the given path. */
export const del = method("DELETE");
/** Starts building a HEAD endpoint at the given path. */
export const head = method("HEAD");
/** Starts building an OPTIONS endpoint at the given path. */
export const options = method("OPTIONS");
type DescriptorOf<T> =
  T extends EndpointBuilder<infer P, infer Q, infer H, infer B, infer R, infer E>
    ? EndpointDescriptor<P, Q, H, B, R, E>
    : T extends AnyEndpointDescriptor
      ? T
      : never;
type Defined<E extends Record<string, AnyEndpointDescriptor | EndpointBuilder>> = {
  [K in keyof E]: DescriptorOf<E[K]>;
};
const snapshotParameters = (parameters: ParameterMap | undefined): ParameterMap | undefined =>
  parameters
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(parameters).map(([name, definition]) => [
            name,
            definition && typeof definition === "object" && !("safeParse" in definition)
              ? Object.freeze({ ...definition })
              : definition,
          ]),
        ),
      )
    : undefined;
const snapshotSecurity = (security: State["security"]): State["security"] =>
  security
    ? Object.freeze(
        security.map((requirement) =>
          Object.freeze(
            Object.fromEntries(
              Object.entries(requirement).map(([name, scopes]) => [
                name,
                Object.freeze([...scopes]),
              ]),
            ),
          ),
        ),
      )
    : undefined;
const snapshotMetadata = (metadata: ApiMetadata): ApiMetadata =>
  Object.freeze({
    ...metadata,
    ...(metadata.servers
      ? {
          servers: Object.freeze(
            metadata.servers.map((server) =>
              typeof server === "string" ? server : Object.freeze({ ...server }),
            ),
          ),
        }
      : {}),
    ...(metadata.tags ? { tags: Object.freeze([...metadata.tags]) } : {}),
    ...(metadata.securitySchemes
      ? { securitySchemes: Object.freeze({ ...metadata.securitySchemes }) }
      : {}),
  });
/**
 * Finalizes a map of {@link EndpointBuilder}s and/or raw {@link EndpointDescriptor}s into
 * a frozen {@link ApiDefinition}, stamping each endpoint's `operationId` from its key and
 * deep-freezing its parameters, security, responses, and errors.
 *
 * @example
 * const api = defineApi({
 *   getUser: get("/users/{id}").returns(json()),
 * });
 */
export function defineApi<E extends Record<string, AnyEndpointDescriptor | EndpointBuilder>>(
  endpoints: E,
  metadata?: ApiMetadata,
): ApiDefinition<Defined<E>> {
  const frozen = Object.fromEntries(
    Object.entries(endpoints).map(([id, value]) => {
      const endpoint = STATE in value ? value[STATE] : value;
      return [
        id,
        Object.freeze({
          ...endpoint,
          operationId: id,
          params: snapshotParameters(endpoint.params),
          query: snapshotParameters(endpoint.query),
          headers: snapshotParameters(endpoint.headers),
          security: snapshotSecurity(endpoint.security),
          responses: Object.freeze({ ...endpoint.responses }),
          errors: Object.freeze({ ...endpoint.errors }),
        }),
      ];
    }),
  ) as Defined<E>;
  return Object.freeze({
    endpoints: Object.freeze(frozen),
    ...(metadata ? { metadata: snapshotMetadata(metadata) } : {}),
  });
}
