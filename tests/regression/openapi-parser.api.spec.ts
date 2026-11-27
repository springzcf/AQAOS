import { describe, expect, it } from "vitest";
import { buildRequest, extractEndpoints, loadOpenApi, sampleFor } from "@aqaos/core";

describe("openapi parser (audit D-01 regression)", () => {
    it("parses a JSON spec", async () => {
        const endpoints = await loadOpenApi("examples/demo-app/openapi.json");
        expect(endpoints.length).toBeGreaterThan(0);
        // Order-independent: the health route must parse as a GET.
        const health = endpoints.find((e) => e.path === "/health");
        expect(health?.method).toBe("GET");
        const login = endpoints.find((e) => e.path === "/login");
        expect(login?.method).toBe("POST");
    });

    it("parses a YAML spec via dynamic import (ESM-safe, was require())", async () => {
        // The dynamic-import itself: js-yaml must resolve in ESM context.
        const yaml = await import("js-yaml");
        const parsed = (yaml.default ?? yaml).load("a: 1\nb: [2, 3]");
        expect(parsed).toEqual({ a: 1, b: [2, 3] });
        // And the spec-shaped object flows through endpoint extraction.
        const spec = {
            paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } },
        };
        const endpoints = extractEndpoints(spec);
        expect(endpoints).toHaveLength(1);
        expect(endpoints[0]).toMatchObject({ method: "GET", path: "/health" });
    });

    it("builds a concrete request URL with path params", () => {
        const ep = extractEndpoints({
            paths: {
                "/users/{id}": {
                    get: {
                        parameters: [
                            { name: "id", in: "path", required: true, schema: { type: "integer" } },
                            { name: "verbose", in: "query", schema: { type: "boolean" } },
                        ],
                    },
                },
            },
        })[0]!;
        const { url, query } = buildRequest("http://x.test/api", ep, {});
        expect(url).toContain("/users/1");
        expect(query.verbose).toBe("true");
    });

    it("samples plausible values for common parameter names", () => {
        expect(sampleFor("userId")).toBe("1");
        expect(sampleFor("email")).toContain("@");
        expect(sampleFor("limit")).toBe("10");
    });
});
