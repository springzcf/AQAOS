/**
 * 服务版本（T-E01-08）：运行时从 package.json 读取，避免硬编码漂移。
 * 相对路径对 tsx（src/）与构建产物（dist/）均指向 apps/api/package.json。
 */

import { readFileSync } from "node:fs";

let cached: string | undefined;

export function serviceVersion(): string {
    if (cached === undefined) {
        const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        cached = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
    }
    return cached;
}
