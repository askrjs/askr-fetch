import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFetch, empty, stream, text, type Middleware } from "../src";
import { bearerAuth, retry } from "../src/middleware";

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cancellation across retry and asynchronous middleware", () => {
  it.each([
    ["abort", false],
    ["timeout", false],
    ["middleware", false],
    ["abort", true],
  ] as const)(
    "should cancel an undelivered stream when outward middleware ends in %s (cancel rejects: %s)",
    async (kind, rejectsCancel) => {
      const controller = new AbortController();
      const reason = new Error("stream cannot be delivered");
      const cancel = vi.fn<(reason: unknown) => void>(() => {
        if (rejectsCancel) throw new Error("source cancellation failed");
      });
      let finishMiddleware!: () => void;
      let reachedStream = false;
      const outward: Middleware = async (context, next) => {
        const result = await next(context);
        reachedStream = result.ok;
        await new Promise<void>((resolve) => {
          finishMiddleware = resolve;
        });
        if (kind === "middleware") throw reason;
        return result;
      };
      const pending = createFetch({
        timeout: 50,
        middleware: [outward],
        fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
      })({ url: "https://example.test", response: stream(), signal: controller.signal });
      await settle();
      expect(reachedStream).toBe(true);
      let outcome: Awaited<typeof pending> | undefined;
      void pending.then((result) => {
        outcome = result;
      });
      if (kind === "abort") controller.abort(reason);
      else if (kind === "timeout") vi.advanceTimersByTime(50);
      else finishMiddleware();
      await settle();
      expect(outcome?.kind).toBe(kind);
      expect(cancel).toHaveBeenCalledOnce();
      if (!outcome || outcome.ok) throw new Error("Expected the outward failure");
      expect(cancel.mock.calls[0]?.[0]).toBe(outcome.error);
      if (kind === "timeout") expect(outcome.error).toMatchObject({ name: "TimeoutError" });
      else expect(outcome.error).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (kind !== "middleware") finishMiddleware();
      await settle();
      expect(await pending).toBe(outcome);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["abort", "resolve"],
    ["abort", "reject"],
    ["timeout", "resolve"],
    ["timeout", "reject"],
  ] as const)(
    "should settle %s before an uncooperative transport finishes, then ignore its late %s",
    async (kind, finish) => {
      const controller = new AbortController();
      const reason = new Error("stop waiting for transport");
      let resolveResponse!: (response: Response) => void;
      let rejectResponse!: (error: Error) => void;
      const response = new Response(new Uint8Array([1, 2, 3]));
      const clone = vi.spyOn(response, "clone");
      const transport = vi.fn(
        () =>
          new Promise<Response>((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;
          }),
      );
      const pending = createFetch({
        fetch: transport,
        ...(kind === "timeout" ? { timeout: 5 } : {}),
      })({
        url: "https://example.test",
        response: stream(),
        signal: controller.signal,
      });
      let outcome: Awaited<typeof pending> | undefined;
      void pending.then((result) => {
        outcome = result;
      });
      await settle();
      if (kind === "abort") controller.abort(reason);
      else vi.advanceTimersByTime(5);
      await settle();
      expect(outcome?.kind).toBe(kind);
      expect(outcome?.status).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (finish === "resolve") resolveResponse(response);
      else rejectResponse(new Error("obsolete transport failure"));
      await settle();
      expect(await pending).toBe(outcome);
      expect(response.body?.locked).toBe(false);
      expect(clone).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["abort", "resolve"],
    ["abort", "reject"],
    ["timeout", "resolve"],
    ["timeout", "reject"],
  ] as const)(
    "should settle %s before stalled middleware finishes, then ignore its late %s",
    async (kind, finish) => {
      const controller = new AbortController();
      const reason = new Error("stop waiting for credentials");
      let resolveToken!: (value: string) => void;
      let rejectToken!: (error: Error) => void;
      const token = new Promise<string>((resolve, reject) => {
        resolveToken = resolve;
        rejectToken = reject;
      });
      const transport = vi.fn(async () => new Response(null, { status: 204 }));
      const observeLaterMiddleware = vi.fn<Middleware>((context, next) => next(context));
      const pending = createFetch({
        fetch: transport,
        middleware: [bearerAuth({ token: () => token }), observeLaterMiddleware],
        ...(kind === "timeout" ? { timeout: 5 } : {}),
      })({ url: "https://example.test", response: empty(), signal: controller.signal });
      let outcome: Awaited<typeof pending> | undefined;
      void pending.then((result) => {
        outcome = result;
      });
      await settle();
      if (kind === "abort") controller.abort(reason);
      else vi.advanceTimersByTime(5);
      await settle();
      expect(outcome?.kind).toBe(kind);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (finish === "resolve") resolveToken("obsolete");
      else rejectToken(new Error("obsolete authentication failure"));
      await settle();
      expect(await pending).toBe(outcome);
      expect(transport).not.toHaveBeenCalled();
      expect(observeLaterMiddleware).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("should skip transport and release timers when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const transport = vi.fn();
    const result = await createFetch({ fetch: transport, timeout: 500, middleware: [retry()] })({
      url: "https://example.test",
      response: text(),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ kind: "abort", error: reason });
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["pending", "ready"] as const)(
    "should stop before another attempt when abort occurs with backoff %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error("cancel retry");
      let signal!: AbortSignal;
      let attempts = 0;
      const capture: Middleware = (context, next) => {
        signal = context.request.signal;
        return next(context);
      };
      const observeAttempt: Middleware = (context, next) => {
        attempts++;
        return next(context);
      };
      const transport = vi.fn(async () => {
        if (transport.mock.calls.length > 1) throw reason;
        // No 503 codec: the decoder still preserves status/response for retry.
        return new Response("untyped busy", { status: 503 });
      });
      const pending = createFetch({
        fetch: transport,
        middleware: [capture, retry({ attempts: 2, delay: () => 1000 }), observeAttempt],
      })({
        url: "https://example.test",
        response: text(),
        signal: controller.signal,
      });
      await settle();
      expect(transport).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      expect(getEventListeners(signal, "abort")).toHaveLength(1);
      if (phase === "ready") {
        // Resolve the timer synchronously, then abort before its awaiting
        // continuation can begin the next attempt.
        vi.advanceTimersByTime(1000);
      }
      controller.abort(reason);
      expect(await pending).toMatchObject({ kind: "abort", error: reason });
      expect(transport).toHaveBeenCalledOnce();
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      vi.advanceTimersByTime(5000);
      await settle();
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each(["abort", "timeout"] as const)(
    "should preserve %s and skip transport when authentication finishes after cancellation",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("authentication no longer needed");
      let resolveToken!: (token: string) => void;
      const token = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
      );
      const transport = vi.fn(async () => new Response(null, { status: 204 }));
      const pending = createFetch({
        fetch: transport,
        middleware: [bearerAuth({ token })],
        ...(kind === "timeout" ? { timeout: 5 } : {}),
      })({ url: "https://example.test", response: empty(), signal: controller.signal });
      await settle();
      expect(token).toHaveBeenCalledOnce();
      if (kind === "abort") controller.abort(reason);
      else vi.advanceTimersByTime(5);
      resolveToken("obsolete");
      const result = await pending;
      expect(result.kind).toBe(kind);
      if (kind === "abort") expect(!result.ok && result.error).toBe(reason);
      else expect(!result.ok && result.error).toMatchObject({ name: "TimeoutError" });
      expect(transport).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("should retain timeout classification during backoff if the wall clock moves backwards", async () => {
    const transport = vi.fn(async () => new Response("busy", { status: 503 }));
    const pending = createFetch({
      fetch: transport,
      timeout: 50,
      middleware: [
        retry({
          attempts: 2,
          delay: () => {
            // Deadline checks use wall time; AbortController's timeout must still
            // identify the cause if the wall clock changes during a request.
            vi.setSystemTime(Date.now() - 1000);
            return 100;
          },
        }),
      ],
    })({ url: "https://example.test", response: text() });
    await settle();
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(50);
    const result = await pending;
    expect(result.kind).toBe("timeout");
    expect(!result.ok && result.error).toMatchObject({ name: "TimeoutError" });
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"] as const)(
    "should preserve %s when cancellation interrupts a buffered response decode",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("stop body decode");
      let requestSignal!: AbortSignal;
      let response!: Response;
      const transport = vi.fn(async (request: Request) => {
        requestSignal = request.signal;
        response = new Response(
          new ReadableStream<Uint8Array>({
            start(body) {
              body.enqueue(new TextEncoder().encode("incomplete"));
              request.signal.addEventListener("abort", () => body.error(request.signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
        return response;
      });
      const pending = createFetch({
        fetch: transport,
        ...(kind === "timeout" ? { timeout: 5 } : {}),
      })({
        url: "https://example.test/body",
        response: text(),
        signal: controller.signal,
      });
      await settle();
      expect(transport).toHaveBeenCalledOnce();
      if (kind === "abort") controller.abort(reason);
      else vi.advanceTimersByTime(5);
      const result = await pending;
      expect(result.kind).toBe(kind);
      expect(!result.ok && result.error).toBe(requestSignal.reason);
      expect(!result.ok && result.response).toBe(response);
      expect(result.status).toBe(200);
      expect(result.url).toBe("https://example.test/body");
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );
});
