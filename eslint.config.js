import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * AQAOS lint policy (T-E01-02).
 *
 *  - typescript-eslint recommended as the baseline;
 *  - layer boundaries as no-restricted-imports rules (SDD §6.2):
 *      domain    → may not import anything above the domain layer
 *      contracts → may import domain only
 *      core      → library, no app/worker imports
 *      apps/workers → may import packages/*
 *  - `no-explicit-any` starts as warn (QA-Swarm transition code carries a few
 *    `any`s); tighten to error in M1 when the runtime lands.
 */
export default tseslint.config(
    {
        ignores: [
            "**/dist/**",
            "**/.next/**",
            "**/node_modules/**",
            "**/coverage/**",
            "qa-swarm-out/**",
            "qa-out/**",
            "test-results/**",
            "playwright-report/**",
            "**/*.d.ts",
        ],
    },
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { prefer: "type-imports", fixStyle: "inline-type-imports" },
            ],
            "no-console": "off",
            eqeqeq: ["error", "smart"],
        },
    },
    // --- layer boundaries -----------------------------------------------------
    {
        files: ["packages/domain/src/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["@aqaos/*", "../../../*", "@*"],
                            message: "The domain layer must not depend on upper layers (SDD §6.2).",
                        },
                    ],
                    paths: [
                        {
                            name: "express",
                            message: "The domain layer must stay framework-free (no I/O).",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ["packages/contracts/src/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: [
                                "@aqaos/core",
                                "@aqaos/cli",
                                "@aqaos/api",
                                "@aqaos/dashboard",
                                "@aqaos/worker-*",
                            ],
                            message: "Contracts may only derive from the domain layer.",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ["packages/core/src/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: [
                                "@aqaos/cli",
                                "@aqaos/api",
                                "@aqaos/dashboard",
                                "@aqaos/worker-*",
                            ],
                            message: "The core library must not depend on applications or workers.",
                        },
                    ],
                },
            ],
        },
    },
    // --- generated/app artifacts excluded from TS rules -----------------------
    {
        files: ["**/*.cjs", "**/*.mjs"],
        ...tseslint.configs.disableTypeChecked,
    },
);
