import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    exclude: ["backup/**", "trash/**", "node_modules/**"],
  },
});
