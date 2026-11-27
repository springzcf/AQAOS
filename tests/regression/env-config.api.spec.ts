import { afterEach, describe, expect, it } from "vitest";
import { envTier, MissingEnvError, validateEnv } from "@aqaos/core";

const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
};

const KEYS = ["ENCRYPTION_KEY", "JWT_SECRET"] as const;

afterEach(() => {
    set("NODE_ENV", "test");
    for (const k of KEYS) set(k, undefined);
});

describe("environment baseline (T-E01-05)", () => {
    it("defaults to the development tier", () => {
        set("NODE_ENV", undefined);
        expect(envTier()).toBe("development");
    });

    it("production boot refuses when secrets are missing", () => {
        set("NODE_ENV", "production");
        for (const k of KEYS) set(k, undefined);
        expect(() => validateEnv()).toThrow(MissingEnvError);
    });

    it("production boot passes when secrets are present", () => {
        set("NODE_ENV", "production");
        for (const k of KEYS) set(k, "x".repeat(43));
        expect(() => validateEnv()).not.toThrow();
    });

    it("empty strings count as missing", () => {
        set("NODE_ENV", "production");
        for (const k of KEYS) set(k, "   ");
        expect(() => validateEnv()).toThrow(/ENCRYPTION_KEY/);
    });

    it("development tier stays zero-config", () => {
        set("NODE_ENV", "development");
        for (const k of KEYS) set(k, undefined);
        expect(() => validateEnv()).not.toThrow();
    });
});
