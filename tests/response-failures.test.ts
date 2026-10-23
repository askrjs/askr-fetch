import { describe, expect, it } from "vite-plus/test";
import { createFetch, json } from "../src";

describe("non-success response decoding context", () => {
  it.each([
    { status: 400, body: "{", mediaType: "application/json", codec: json(), error: SyntaxError },
    { status: 415, body: "plain", mediaType: "text/plain", codec: json(), error: TypeError },
    { status: 503, body: "busy", mediaType: "text/plain", codec: undefined, error: TypeError },
  ])("should retain the response when status $status cannot be decoded", async (input) => {
    const response = new Response(input.body, {
      status: input.status,
      headers: { "content-type": input.mediaType, "x-request-id": "failure-context" },
    });
    const result = await createFetch({ fetch: async () => response })({
      url: "https://example.test/failure",
      errors: input.codec ? { [input.status]: input.codec } : {},
    });
    expect(result.kind).toBe("decode");
    expect(result.status).toBe(input.status);
    expect(result.url).toBe("https://example.test/failure");
    expect(result.headers.get("x-request-id")).toBe("failure-context");
    if (result.ok) throw new Error("Expected a decode failure");
    expect(result.error).toBeInstanceOf(input.error);
    expect(result.response).toBe(response);
  });
});
