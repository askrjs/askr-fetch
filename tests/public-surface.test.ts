import { describe, expect, it } from "vite-plus/test";
import * as root from "../src";
import * as middleware from "../src/middleware";

describe("curated public runtime entrypoints", () => {
  it("should expose request authoring and result handling without the path parser", () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        "FetchError",
        "arrayBuffer",
        "blob",
        "content",
        "createClient",
        "createFetch",
        "defineApi",
        "del",
        "empty",
        "get",
        "head",
        "json",
        "multipart",
        "options",
        "patch",
        "post",
        "put",
        "stream",
        "text",
        "unwrap",
        "urlEncoded",
      ].sort(),
    );
  });

  it("should expose middleware factories through their dedicated entrypoint", () => {
    expect(Object.keys(middleware).sort()).toEqual(
      ["apiKeyAuth", "bearerAuth", "logging", "retry", "telemetry"].sort(),
    );
  });
});
