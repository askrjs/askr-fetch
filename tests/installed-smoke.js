import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), "askr-fetch-installed-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const packOutput = execFileSync(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const packed = JSON.parse(packOutput);
  const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const tarball = join(sandbox, filename);
  const consumer = join(sandbox, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  execFileSync(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    { cwd: consumer, stdio: "pipe" },
  );

  const installedPackage = JSON.parse(
    readFileSync(join(consumer, "node_modules", "@askrjs", "fetch", "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);

  writeFileSync(
    join(consumer, "smoke.js"),
    `
      import assert from "node:assert/strict";
      import { createClient, defineApi, get, text } from "@askrjs/fetch";
      import { bearerAuth } from "@askrjs/fetch/middleware";

      const api = defineApi({ health: get("/health").returns(text()) });
      const client = createClient(api, {
        baseUrl: "https://example.test",
        middleware: [bearerAuth({ token: "installed" })],
        fetch: async (request) => {
          assert.equal(request.headers.get("authorization"), "Bearer installed");
          return new Response("ok", { headers: { "content-type": "text/plain" } });
        },
      });
      const result = await client.health();
      assert.equal(result.ok, true);
      assert.equal(result.kind, "success");
      assert.equal(result.data, "ok");
      assert.equal(result.url, "https://example.test/health");
    `,
  );
  execFileSync(process.execPath, [join(consumer, "smoke.js")], { cwd: consumer, stdio: "pipe" });

  writeFileSync(
    join(consumer, "retry-body.js"),
    `
      import assert from "node:assert/strict";
      import { createFetch, json, text } from "@askrjs/fetch";
      import { retry } from "@askrjs/fetch/middleware";

      const bodies = [];
      const result = await createFetch({
        middleware: [retry({ attempts: 2, delay: () => 0 })],
        fetch: async (request) => {
          bodies.push(await request.text());
          return new Response(bodies.length === 1 ? "retry" : "ok", {
            status: bodies.length === 1 ? 503 : 200,
            headers: { "content-type": "text/plain", "retry-after": "0" },
          });
        },
      })({
        url: "https://example.test/items/1",
        method: "PUT",
        headers: { "x-request": "installed" },
        body: { name: "updated" },
        bodyCodec: json(),
        response: text(),
        errors: { 503: text() },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(bodies, ['{"name":"updated"}', '{"name":"updated"}']);
    `,
  );
  execFileSync(process.execPath, [join(consumer, "retry-body.js")], {
    cwd: consumer,
    stdio: "pipe",
  });

  writeFileSync(
    join(consumer, "fixture.ts"),
    `
      import { createClient, defineApi, get, json } from "@askrjs/fetch";
      import { retry } from "@askrjs/fetch/middleware";

      const api = defineApi({
        read: get("/items/{id}")
          .params<{ id: string }>()
          .returns(200, json<{ id: string }>()),
      });
      const client = createClient(api, {
        baseUrl: "https://example.test",
        middleware: [retry()],
      });
      const result = await client.read({ params: { id: "item-1" } });
      if (result.ok && result.status === 200) result.data.id satisfies string;
      // @ts-expect-error path parameters remain required from the installed declarations
      void client.read();
    `,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          lib: ["ES2022", "DOM", "DOM.Iterable"],
        },
        include: ["fixture.ts"],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.json",
    ],
    { cwd: consumer, stdio: "pipe" },
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
