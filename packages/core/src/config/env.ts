/**
 * AQAOS environment baseline (T-E01-05).
 *
 * Rules:
 *  - development tier stays zero-config (offline/mock defaults);
 *  - production refuses to boot when a required secret is missing
 *    (fail-fast, no silent downgrade);
 *  - nothing here ever logs secret values.
 */

export type EnvTier = "development" | "staging" | "production";

export class MissingEnvError extends Error {
    constructor(public readonly missingKeys: string[]) {
        super(
            `missing required environment variable(s): ${missingKeys.join(", ")} — ` +
                `generate them per .env.example and restart (NODE_ENV=${envTier()})`,
        );
        this.name = "MissingEnvError";
    }
}

/** Keys that MUST be present when NODE_ENV=production (staging warns). */
export const PRODUCTION_REQUIRED_KEYS = ["ENCRYPTION_KEY", "JWT_SECRET"] as const;

export function envTier(): EnvTier {
    const raw = process.env.NODE_ENV ?? "development";
    if (raw === "staging" || raw === "production") return raw;
    return "development";
}

/**
 * Fail-fast startup check. Throws MissingEnvError in production when any
 * required key is absent or empty; logs a warning in staging; no-op in
 * development.
 */
export function validateEnv(required: readonly string[] = PRODUCTION_REQUIRED_KEYS): void {
    const tier = envTier();
    const missing = required.filter((k) => !process.env[k]?.trim());
    if (missing.length === 0) return;
    if (tier === "production") {
        throw new MissingEnvError(missing);
    }
    if (tier === "staging") {
        console.warn(
            `[aqaos/config] staging tier is missing ${missing.join(", ")} — ` +
                `production boot will refuse without them`,
        );
    }
}

/** Read a variable or throw a precise error (use for hard dependencies). */
export function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new MissingEnvError([name]);
    return value;
}
