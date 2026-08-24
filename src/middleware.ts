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
/**
 * Middleware that attaches an `Authorization: Bearer <token>` header to every request.
 * `token` may be a static string or a (possibly async) function resolved on each request.
 */
export const bearerAuth =
  ({ token }: { token: string | (() => string | Promise<string>) }): Middleware =>
  async (context, next) => {
    const resolved = typeof token === "function" ? await token() : token;
    return next(
      replaceHeaders(context, (headers) => headers.set("authorization", `Bearer ${resolved}`)),
    );
  };
/**
 * Middleware that attaches an API key to every request, either as a header or a query
 * parameter (`in`, default `"header"`). `value` may be a static string or a (possibly
 * async) function resolved on each request. The key is marked sensitive so the
 * {@link logging} middleware redacts it.
 */
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
/** Options controlling the {@link retry} middleware's behavior. */
export interface RetryOptions {
  /** Maximum number of attempts, including the first. Defaults to 3. */
  attempts?: number;
  /** HTTP methods eligible for retry. Defaults to idempotent-by-convention methods. */
  methods?: readonly string[];
  /** Response statuses that trigger a retry. Defaults to common transient failure codes. */
  statuses?: readonly number[];
  /** Computes the delay (ms) before the given retry attempt, if no `Retry-After` header is present. */
  delay?: (attempt: number) => number;
  /** Maximum delay (ms) accepted from `Retry-After`. Defaults to 60 seconds. */
  maxRetryAfter?: number;
}
/**
 * Middleware that retries failed requests. Retries eligible methods on network failures
 * or eligible response statuses, honoring a `Retry-After` header when present and
 * stopping early if the request's deadline would be exceeded. A non-streaming request body
 * is replayed only when it can be cloned before the first attempt; streaming, already-consumed,
 * or otherwise non-cloneable bodies are sent once without retrying.
 */
export function retry(options: RetryOptions = {}): Middleware {
  const attempts = options.attempts ?? 3;
  const methods = options.methods ?? ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"];
  const statuses = options.statuses ?? [408, 425, 429, 500, 502, 503, 504];
  const maxRetryAfter = options.maxRetryAfter ?? 60_000;
  if (!Number.isFinite(maxRetryAfter) || maxRetryAfter < 0)
    throw new TypeError("maxRetryAfter must be a non-negative finite number");
  return async (context, next) => {
    if (!methods.includes(context.request.method)) return next(context);
    if (context.replayableBody === false) return next(context);
    let replayable: Request | undefined;
    if (context.request.body) {
      try {
        replayable = context.request.clone();
      } catch {
        return next(context);
      }
    }
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
      const fallback = () => options.delay?.(attempt) ?? 100 * 2 ** (attempt - 2);
      const parsedRetryAfter = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : undefined;
      const wait =
        parsedRetryAfter === undefined || !Number.isFinite(parsedRetryAfter)
          ? fallback()
          : Math.min(parsedRetryAfter, maxRetryAfter);
      if (context.deadline !== undefined && Date.now() + wait >= context.deadline) break;
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
      let request: Request;
      try {
        request = (replayable ?? context.request).clone();
      } catch {
        break;
      }
      result = await next(Object.freeze({ ...context, attempt, request }));
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
/**
 * Middleware that logs a `"request"` event before and a `"response"` event after each
 * request, via the given logger (defaults to `console`). Headers and query parameters
 * marked sensitive (e.g. by {@link apiKeyAuth}) or matching common sensitive-name
 * patterns (authorization, cookie, token, secret, password, api key) are redacted.
 */
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
/** Hooks invoked by the {@link telemetry} middleware around each request. */
export interface TelemetryHooks {
  /** Called before the request proceeds; its return value (a "span") is passed to `end`/`error`. */
  start?(context: RequestContext): unknown;
  /** Called after the request completes successfully (from this middleware's perspective). */
  end?(span: unknown, result: FetchResult): void;
  /** Called if a downstream middleware or the transport throws. */
  error?(span: unknown, error: unknown): void;
}
/**
 * Middleware that wraps each request with {@link TelemetryHooks}, calling `start` before
 * the request, `end` after it completes, and `error` (then rethrowing) if it throws.
 */
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
