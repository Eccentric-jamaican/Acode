import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browserMcpServer.ts",
    "src/browserUseClient.mjs",
    "src/imagegenMcpServer.ts",
  ],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => id.startsWith("@t3tools/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
