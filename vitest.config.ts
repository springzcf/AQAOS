import { defineConfig } from "vitest/config";

/**
 * Unit/regression test runner (T-E01-02, fixes audit D-02).
 *
 * Layering:
 *  - vitest: unit + logic regression (tests/regression, colocated *.test.ts)
 *  - playwright: browser E2E only (tests/e2e) — see playwright.config.ts
 */
export default defineConfig({
    test: {
        include: [
            "tests/regression/**/*.spec.ts",
            "packages/*/src/**/*.test.ts",
            "workers/*/src/**/*.test.ts",
        ],
        environment: "node",
        reporters: ["default"],
    },
});
