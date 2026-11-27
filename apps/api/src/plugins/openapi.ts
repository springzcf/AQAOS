/**
 * OpenAPI 文档自动生成（T-E01-08）：@fastify/swagger 聚合路由 schema 生成规范，
 * Swagger UI 挂 /docs，机器可读规范挂 /docs/openapi.json 与 /openapi.json。
 */

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";

export interface OpenApiPluginOptions extends FastifyPluginOptions {
    version: string;
}

export const DOCS_ROUTE = "/docs";
export const OPENAPI_JSON_ROUTE = "/openapi.json";

const plugin: FastifyPluginAsync<OpenApiPluginOptions> = async (app, options) => {
    await app.register(swagger, {
        openapi: {
            openapi: "3.0.3",
            info: {
                title: "AQAOS Control Plane API",
                version: options.version,
                description:
                    "多 Agent 自主 QA 平台控制面。统一前缀 /api/v1；错误契约见 DDD §8.1/§16；认证在 T-E01-09 接入。",
                license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
            },
            servers: [{ url: "/", description: "local" }],
            tags: [
                { name: "meta", description: "服务元信息" },
                { name: "health", description: "存活与就绪探针" },
                {
                    name: "runs",
                    description:
                        "QA Run 生命周期；创建需 Idempotency-Key（DDD §8.1），实现随 Run Registry（T-E02-12）落地",
                },
            ],
        },
    });
    await app.register(swaggerUi, { routePrefix: DOCS_ROUTE });

    app.get(OPENAPI_JSON_ROUTE, { schema: { hide: true } }, async () => app.swagger());
};

// fp 包装突破封装：swagger 的 onRoute 挂到根作用域，聚合后续所有路由的 schema。
export const openapiPlugin = fp(plugin, { name: "aqaos-openapi" });
