import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), "askr-fetch-installed-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the installed smoke test through npm run test:installed.");
const runNpm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const contract = JSON.parse(
  readFileSync(join(repositoryRoot, "tests", "public-contract.json"), "utf8"),
);
const schemaRange =
  manifest.dependencies?.["@askrjs/schema"] ??
  manifest.peerDependencies?.["@askrjs/schema"] ??
  manifest.devDependencies?.["@askrjs/schema"];
if (!schemaRange) {
  throw new Error("@askrjs/schema must be declared in package.json for the installed smoke test.");
}

try {
  const packOutput = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const packed = JSON.parse(packOutput);
  const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const tarball = join(sandbox, filename);
  const consumer = join(sandbox, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  runNpm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
      `@askrjs/schema@${schemaRange}`,
    ],
    { cwd: consumer, stdio: "pipe" },
  );

  const installedPackage = JSON.parse(
    readFileSync(join(consumer, "node_modules", "@askrjs", "fetch", "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.deepEqual(Object.keys(installedPackage.exports).sort(), contract.exportKeys.sort());

  writeFileSync(
    join(consumer, "surface.js"),
    `
    import assert from "node:assert/strict";
    import * as root from "@askrjs/fetch";
    import * as middleware from "@askrjs/fetch/middleware";
    assert.deepEqual(Object.keys(root).sort(), ${JSON.stringify(contract.rootValues)});
    assert.deepEqual(Object.keys(middleware).sort(), ${JSON.stringify(contract.middlewareValues)});
    for (const subpath of ${JSON.stringify(contract.privateSubpaths)}) {
      await assert.rejects(import("@askrjs/fetch/" + subpath), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
  `,
  );
  execFileSync(process.execPath, [join(consumer, "surface.js")], { cwd: consumer, stdio: "pipe" });

  writeFileSync(
    join(consumer, "smoke.js"),
    `
      import assert from "node:assert/strict";
      import { createClient, createFetch, defineApi, get, json, text } from "@askrjs/fetch";
      import { bearerAuth } from "@askrjs/fetch/middleware";
      import { schema } from "@askrjs/schema";

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

      const userSchema = schema.object({ id: schema.uuid() });
      const invalidUser = { id: "not-a-uuid" };
      const parsed = userSchema.safeParse(invalidUser);
      assert.equal(parsed.success, false);
      const invalid = await createFetch({
        fetch: async () => new Response(JSON.stringify(invalidUser), {
          headers: { "content-type": "application/json" },
        }),
      })({ url: "https://example.test/users/1", response: json(userSchema) });
      assert.equal(invalid.kind, "decode");
      assert.deepEqual(invalid.error, parsed.issues);
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
      import type { ClientOptions, Codec, FetchResult, Middleware, Validator } from "@askrjs/fetch";
      import { retry } from "@askrjs/fetch/middleware";
      import { schema } from "@askrjs/schema";

      const userSchema = schema.object({
        id: schema.uuid(),
        name: schema.string({ minLength: 1 }),
      });
      const userCodec = json(userSchema);
      userCodec satisfies Codec<{ id: string; name: string }>;
      const passthrough: Middleware = (context, next) => next(context);
      const options: ClientOptions = { middleware: [passthrough, retry()] };
      const validator: Validator<number> = {
        safeParse: (value) => ({ success: true, data: Number(value) }),
      };
      json(validator) satisfies Codec<number>;
      const outcomeKind = (result: FetchResult) => result.kind;

      const api = defineApi({
        read: get("/items/{id}")
          .params<{ id: string }>({ id: schema.uuid() })
          .returns(200, userCodec),
      });
      const client = createClient(api, {
        ...options,
        baseUrl: "https://example.test",
        middleware: [retry()],
      });
      const result = await client.read({
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });
      if (result.ok && result.status === 200) result.data.name satisfies string;
      outcomeKind(result);
      // @ts-expect-error path parameters remain required from the installed declarations
      void client.read();
    `,
  );
  const removedFixture = [
    ...contract.removedRoot.map(
      (name) =>
        `// @ts-expect-error removed public name\nimport ${name === "pathNames" ? "" : "type "}{ ${name} } from "@askrjs/fetch";`,
    ),
    ...contract.removedMiddleware.map(
      (name) =>
        `// @ts-expect-error removed public middleware type\nimport type { ${name} } from "@askrjs/fetch/middleware";`,
    ),
  ].join("\n");
  writeFileSync(join(consumer, "removed.ts"), removedFixture + "\n");
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
        include: ["fixture.ts", "removed.ts"],
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
  // The native TypeScript 7 CLI checks consumer inference above; TypeScript 6
  // supplies the compiler API for a complete declaration export inventory.
  const fixturePath = join(consumer, "fixture.ts");
  const program = ts.createProgram([fixturePath, join(consumer, "removed.ts")], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => consumer,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  for (const [name, expected] of [
    ["@askrjs/fetch", [...contract.rootValues, ...contract.rootTypes].sort()],
    ["@askrjs/fetch/middleware", contract.middlewareValues],
  ]) {
    const declaration = program
      .getSourceFile(fixturePath)
      .statements.find(
        (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === name,
      );
    assert.ok(declaration, `missing consumer import for ${name}`);
    const symbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
    assert.ok(symbol, `unresolved declaration module for ${name}`);
    assert.deepEqual(
      checker
        .getExportsOfModule(symbol)
        .map((item) => item.name)
        .sort(),
      expected,
    );
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
