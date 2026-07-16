import type { AnyEndpointDescriptor, ApiDefinition, ApiMetadata, Codec, EndpointDescriptor, HttpMethod, ParameterMap } from "./types";

const PATH_NAME = /^[A-Za-z_$][\w$]*$/;
export function pathNames(path: string): string[] {
  if (path.includes(":" ) || path.includes("*")) throw new TypeError(`Invalid path syntax: ${path}`);
  const names: string[] = []; let index = 0;
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    if (match.index !== undefined && path.slice(index, match.index).includes("{") || !PATH_NAME.test(match[1]!)) throw new TypeError(`Malformed path parameter in ${path}`);
    if (names.includes(match[1]!)) throw new TypeError(`Duplicate path parameter: ${match[1]}`);
    names.push(match[1]!); index = (match.index ?? 0) + match[0].length;
  }
  if (path.slice(index).includes("{") || path.includes("}" ) && names.length === 0) throw new TypeError(`Malformed path parameter in ${path}`);
  return names;
}
type Responses = Record<number, Codec>;
type Errors = Partial<Record<number | "default", Codec>>;
type State = Omit<EndpointDescriptor, "responses" | "errors"> & { responses: Responses; errors: Errors };
const STATE = Symbol("endpoint-state");
export interface EndpointBuilder<P = undefined, Q = undefined, H = undefined, B = undefined, R extends Responses = {}, E extends Errors = {}> {
  readonly [STATE]: State;
  params<T extends Record<string, unknown>>(spec?: ParameterMap): EndpointBuilder<T, Q, H, B, R, E>;
  query<T extends Record<string, unknown>>(spec?: ParameterMap): EndpointBuilder<P, T, H, B, R, E>;
  headers<T extends Record<string, unknown>>(spec?: ParameterMap): EndpointBuilder<P, Q, T, B, R, E>;
  body<C extends Codec>(codec: C): EndpointBuilder<P, Q, H, C extends Codec<infer T> ? T : never, R, E>;
  returns<C extends Codec>(codec: C): EndpointBuilder<P, Q, H, B, R & Record<200, C>, E>;
  returns<S extends number, C extends Codec>(status: S, codec: C): EndpointBuilder<P, Q, H, B, R & Record<S, C>, E>;
  errors<T extends Errors>(spec: T): EndpointBuilder<P, Q, H, B, R, E & T>;
  security(requirements: readonly Readonly<Record<string, readonly string[]>>[]): EndpointBuilder<P, Q, H, B, R, E>;
}
const needsEmpty = (state: State, status: number) => status === 204 || status === 205 || state.method === "HEAD";
function build<P = undefined, Q = undefined, H = undefined, B = undefined, R extends Responses = {}, E extends Errors = {}>(state: State): EndpointBuilder<P, Q, H, B, R, E> {
  const update = (next: Partial<State>) => build({ ...state, ...next });
  const value = {
    [STATE]: state,
    params(spec?: ParameterMap) { const names = pathNames(state.path); if (spec && (Object.keys(spec).some((k) => !names.includes(k)) || names.some((k) => !(k in spec)))) throw new TypeError(`Path params must exactly match ${names.join(", ")}`); return update({ params: spec ?? Object.fromEntries(names.map((name) => [name, undefined])) }); },
    query(spec: ParameterMap = {}) { return update({ query: spec }); }, headers(spec: ParameterMap = {}) { return update({ headers: spec }); }, body(value: Codec) { return update({ body: value }); },
    returns(statusOrCodec: number | Codec, maybeCodec?: Codec) { const status = typeof statusOrCodec === "number" ? statusOrCodec : 200; const responseCodec = typeof statusOrCodec === "number" ? maybeCodec! : statusOrCodec; if (status < 200 || status > 299) throw new TypeError("returns() accepts only 2xx statuses"); if (needsEmpty(state, status) && responseCodec.kind !== "empty") throw new TypeError(`${state.method} ${status} requires empty()`); return update({ responses: { ...state.responses, [status]: responseCodec } }); },
    errors(spec: Errors) { for (const key of Object.keys(spec)) if (key !== "default" && Number(key) >= 200 && Number(key) <= 299) throw new TypeError("errors() accepts only non-2xx statuses or default"); return update({ errors: { ...state.errors, ...spec } }); },
    security(security: State["security"]) { return update({ security }); },
  };
  return Object.freeze(value) as EndpointBuilder<P, Q, H, B, R, E>;
}
const method = (value: HttpMethod) => (path: string) => { const names = pathNames(path); return build({ method: value, path, params: names.length ? Object.fromEntries(names.map((name) => [name, undefined])) : undefined, responses: {}, errors: {} }); };
export const get = method("GET"); export const post = method("POST"); export const put = method("PUT"); export const patch = method("PATCH"); export const del = method("DELETE"); export const head = method("HEAD"); export const options = method("OPTIONS");
type DescriptorOf<T> = T extends EndpointBuilder<infer P, infer Q, infer H, infer B, infer R, infer E> ? EndpointDescriptor<P, Q, H, B, R, E> : T extends AnyEndpointDescriptor ? T : never;
type Defined<E extends Record<string, AnyEndpointDescriptor | EndpointBuilder>> = { [K in keyof E]: DescriptorOf<E[K]> };
export function defineApi<E extends Record<string, AnyEndpointDescriptor | EndpointBuilder>>(endpoints: E, metadata?: ApiMetadata): ApiDefinition<Defined<E>> {
  const frozen = Object.fromEntries(Object.entries(endpoints).map(([id, value]) => { const endpoint = STATE in value ? value[STATE] : value; return [id, Object.freeze({ ...endpoint, operationId: id, responses: Object.freeze({ ...endpoint.responses }), errors: Object.freeze({ ...endpoint.errors }) })]; })) as Defined<E>;
  return Object.freeze({ endpoints: Object.freeze(frozen), ...(metadata ? { metadata: Object.freeze({ ...metadata }) } : {}) });
}
