import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/**/*.test.ts", "src/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
  },
});
