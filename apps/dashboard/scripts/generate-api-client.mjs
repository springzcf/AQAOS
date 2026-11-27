/**
 * OpenAPI → typed client 生成（T-E01-10）。
 *
 * 从运行中的 Control Plane API 拉取 /openapi.json，经 openapi-typescript 生成
 * src/lib/api-schema.d.ts（提交入库，供 openapi-fetch 全链路类型化）。
 * 用法：先启动 API（npm run dev -w @aqaos/api），再 `npm run gen:api -w @aqaos/dashboard`。
 * API 变更路由/schema 后需重新生成——契约漂移即编译失败（openapi-fetch 的 paths 泛型）。
 */

import { writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";

const base = process.env.AQAOS_API_BASE_URL ?? "http://localhost:4317";
const response = await fetch(`${base}/openapi.json`);
if (!response.ok) {
  console.error(`Failed to fetch OpenAPI spec from ${base}/openapi.json: ${response.status}`);
  process.exit(1);
}
const spec = await response.json();
const ast = await openapiTS(spec);
const target = new URL("../src/lib/api-schema.d.ts", import.meta.url);
await writeFile(target, astToString(ast));
console.log(`Wrote ${pathOf(target)} (${spec.info?.version ?? "?"})`);

function pathOf(url) {
  return url.pathname.split("/").slice(-3).join("/");
}
