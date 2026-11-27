import { defineConfig } from "@playwright/test";

/**
 * AQAOS browser E2E config (T-E01-02, fixes audit D-05).
 *
 * Only tests/e2e runs here — unit/regression tests moved to vitest
 * (vitest.config.ts). Generated app tests live under qa-swarm-out/tests and
 * run with their own config.
 */
export default defineConfig({
    testDir: "./tests/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI
        ? [["github"], ["junit", { outputFile: "test-results/junit.xml" }]]
        : [["list"]],
    timeout: 30_000,
    expect: { timeout: 5_000 },
    use: {
        baseURL: process.env.QA_BASE_URL ?? "http://localhost:4318",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    webServer: process.env.QA_BASE_URL
        ? undefined
        : {
              command: "npm run start --workspace @aqaos/demo-app",
              url: "http://localhost:4318/health",
              reuseExistingServer: !process.env.CI,
              timeout: 30_000,
          },
});
