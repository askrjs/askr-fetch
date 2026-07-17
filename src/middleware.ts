import type { FetchResult, Middleware, RequestContext } from "./types";

const SENSITIVE = Symbol("askr-fetch-sensitive-fields");
interface SensitiveFields {
  readonly headers: readonly string[];
  readonly query: readonly string[];
}
type SensitiveContext = RequestContext & { readonly [SENSITIVE]?: SensitiveFields };
const markSensitive = (
  context: RequestContext,
  location: "headers" | "query",
  name: string,
): RequestContext => {
  const current = (context as SensitiveContext)[SENSITIVE] ?? { headers: [], query: [] };
  return Object.freeze({
    ...context,
    [SENSITIVE]: Object.freeze({
      ...current,
      [location]: Object.freeze([...new Set([...current[location], name.toLowerCase()])]),
    }),
  });
};
const replaceHeaders = (
  context: RequestContext,
  mutate: (headers: Headers) => void,
): RequestContext => {
  const headers = new Headers(context.request.headers);
  mutate(headers);
  return Object.freeze({ ...context, request: new Request(context.request, { headers }) });
};
export const bearerAuth =
  ({ token }: { token: string | (() => string | Promise<string>) }): Middleware =>
  async (context, next) => {
    const resolved = typeof token === "function" ? await token() : token;
    return next(
      replaceHeaders(context, (headers) => headers.set("authorization", `Bearer ${resolved}`)),
    );
  };
export function apiKeyAuth({
  key,
  value,
  in: location = "header",
}: {
  key: string;
  value: string | (() => string | Promise<string>);
  in?: "header" | "query";
}): Middleware {
  return async (context, next) => {
    const resolved = typeof value === "function" ? await value() : value;
    if (location === "header")
      return next(
        markSensitive(
          replaceHeaders(context, (headers) => headers.set(key, resolved)),
          "headers",
          key,
        ),
      );
    const url = new URL(context.request.url);
    url.searchParams.set(key, resolved);
    return next(
      markSensitive(
        Object.freeze({ ...context, request: new Request(url, context.request) }),
        "query",
        key,
      ),
    );
  };
}
export interface RetryOptions {
  attempts?: number;
  methods?: readonly string[];
  statuses?: readonly number[];
  delay?: (attempt: number) => number;
}
export function retry(options: RetryOptions = {}): Middleware {
  const attempts = options.attempts ?? 3;
  const methods = options.methods ?? ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"];
  const statuses = options.statuses ?? [408, 425, 429, 500, 502, 503, 504];
  return async (context, next) => {
    if (!methods.includes(context.request.method) || context.request.body) return next(context);
    let result: FetchResult = await next(context);
    for (
      let attempt = 2;
      attempt <= attempts &&
      !result.ok &&
      (result.kind === "network" ||
        (result.response !== undefined && statuses.includes(result.status)));
      attempt++
    ) {
      const retryAfter = "response" in result ? result.response?.headers.get("retry-after") : null;
      const wait = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : (options.delay?.(attempt) ?? 100 * 2 ** (attempt - 2));
      if (context.deadline && Date.now() + wait >= context.deadline) break;
      const ready = await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        const timer = setTimeout(() => {
          context.request.signal.removeEventListener("abort", onAbort);
          resolve(true);
        }, wait);
        if (context.request.signal.aborted) onAbort();
        else context.request.signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!ready)
        return {
          ok: false,
          kind: "abort",
          status: 0,
          error: context.request.signal.reason,
          headers: new Headers(),
          url: context.request.url,
        };
      result = await next(Object.freeze({ ...context, attempt, request: context.request.clone() }));
    }
    return result;
  };
}
const SENSITIVE_NAME =
  /(?:^|[-_])(authorization|cookie|token|secret|password|api[-_]?key)(?:$|[-_])/i;
const redacted = (headers: Headers, names: readonly string[] = []) =>
  Object.fromEntries(
    [...headers].map(([key, value]) => [
      key,
      SENSITIVE_NAME.test(key) || names.includes(key.toLowerCase()) ? "[REDACTED]" : value,
    ]),
  );
const redactedUrl = (value: string, names: readonly string[] = []): string => {
  const url = new URL(value);
  for (const key of new Set(url.searchParams.keys()))
    if (SENSITIVE_NAME.test(key) || names.includes(key.toLowerCase())) {
      const count = url.searchParams.getAll(key).length;
      url.searchParams.delete(key);
      for (let index = 0; index < count; index++) url.searchParams.append(key, "[REDACTED]");
    }
  return url.toString();
};
export function logging(
  logger: { log(event: Record<string, unknown>): void } = console,
): Middleware {
  return async (context, next) => {
    const sensitive = (context as SensitiveContext)[SENSITIVE];
    logger.log({
      phase: "request",
      operationId: context.operationId,
      method: context.request.method,
      url: redactedUrl(context.request.url, sensitive?.query),
      headers: redacted(context.request.headers, sensitive?.headers),
      attempt: context.attempt,
    });
    const result = await next(context);
    logger.log({
      phase: "response",
      operationId: context.operationId,
      kind: result.kind,
      status: result.status,
      attempt: context.attempt,
    });
    return result;
  };
}
export interface TelemetryHooks {
  start?(context: RequestContext): unknown;
  end?(span: unknown, result: FetchResult): void;
  error?(span: unknown, error: unknown): void;
}
export function telemetry(hooks: TelemetryHooks): Middleware {
  return async (context, next) => {
    const span = hooks.start?.(context);
    try {
      const result = await next(context);
      hooks.end?.(span, result);
      return result;
    } catch (error) {
      hooks.error?.(span, error);
      throw error;
    }
  };
}
