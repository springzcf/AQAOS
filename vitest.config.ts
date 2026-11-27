import { defineConfig } from "vitest/config";

/**
 * Unit/regression test runner (T-E01-02, fixes audit D-02；T-E02-03 增补).
 *
 * Layering:
 *  - vitest: unit + logic regression (tests/regression, colocated *.test.ts,
 *    incl. apps 的 live-DB 套件)
 *  - playwright: browser E2E only (tests/e2e) — see playwright.config.ts
 *
 * tests/setup/globals.ts：Node 18 vitest worker 的 WebCrypto 兜底
 * （jose webapi 构建裸引用 crypto；重装依赖树后 2.1.9 worker 沙箱缺失）。
 */
export default defineConfig({
    test: {
        include: [
            "tests/regression/**/*.spec.ts",
            "packages/*/src/**/*.test.ts",
            "workers/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
        ],
        environment: "node",
        reporters: ["default"],
        setupFiles: ["tests/setup/globals.ts"],
    },
});
