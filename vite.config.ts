import { defineConfig } from "vite-plus";

export default defineConfig({
  check: {
    fmt: true,
    lint: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/coverage/**", "**/test-artifacts/**"],
  },
});
