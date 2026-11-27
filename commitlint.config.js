/**
 * AQAOS commit convention (T-E01-02).
 *
 * Conventional Commits, scoped by workspace/domain:
 *   feat(runner): ...
 *   fix(triage): ...
 *   docs(srs): ...
 *   chore(e01): ...
 */
export default {
    extends: ["@commitlint/config-conventional"],
    rules: {
        "scope-enum": [
            2,
            "always",
            [
                "core",
                "domain",
                "contracts",
                "cli",
                "api",
                "dashboard",
                "agent",
                "web",
                "worker",
                "environment",
                "runner",
                "memory",
                "gateway",
                "docs",
                "e01",
                "e02",
                "e03",
                "e04",
                "e05",
                "e06",
                "e07",
                "e08",
                "e09",
                "e10",
                "e11",
                "e12",
                "ops",
                "aud",
                "repo",
            ],
        ],
    },
};
