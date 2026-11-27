/**
 * Control Plane API 类型化客户端（T-E01-10）。
 *
 * openapi-fetch + 生成的 api-schema.d.ts：路由/参数/响应全链路类型化，
 * 契约漂移（API schema 变更未重新 gen:api）即 dashboard 编译失败。
 * 服务端组件经 BFF Cookie 取 token 后注入 Authorization；
 * 浏览器侧不直接携带凭据访问 API（认证全部走 /api/auth/* 路由代理）。
 */

import createClient from "openapi-fetch";
import type { paths } from "./api-schema";

/** 服务端访问 API 的地址（容器内用内网服务名；本地默认 4317）。 */
export const API_BASE_URL =
    process.env.AQAOS_API_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4317";

export function apiClient(authToken?: string) {
    return createClient<paths>({
        baseUrl: API_BASE_URL,
        headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
    });
}
