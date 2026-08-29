import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the web client's own alias so its modules resolve in tests too.
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
