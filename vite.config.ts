import { defineConfig } from "vite-plus";
export default defineConfig({ pack: { entry: { index: "src/index.ts", middleware: "src/middleware.ts" }, format: ["esm"], outDir: "dist", platform: "neutral", dts: true, unbundle: true } });
