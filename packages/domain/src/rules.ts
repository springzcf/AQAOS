/**
 * 跨实体建模规则（DDD §2.1 建模规则，T-E02-01 纯函数；T-E11-06 API/UI 消费）。
 *
 * 1. api 型应用必须提供 OpenAPI（否则无法生成契约测试）；
 * 2. TestRun.platforms 必须是所选应用能力集合的子集：
 *    - web 应用能力 = {web}（配置了 openApiUrl 时扩展为 {web, api}）；
 *    - api 应用能力 = {api}。
 */

import type { Application } from "./application.js";
import { PlatformSchema } from "./enums.js";
import type { TestRun } from "./run.js";

/** 应用可执行的 platform 能力集合（web+openApiUrl → 双能力）。 */
export function applicationCapabilities(application: Application): readonly string[] {
    if (application.platform === "web") {
        return application.config.openApiUrl !== undefined ? ["web", "api"] : ["web"];
    }
    return ["api"];
}

/** api 型应用必须提供 OpenAPI（建模规则 1）。 */
export function applicationMeetsOpenApiRequirement(application: Application): boolean {
    return !(application.platform === "api" && application.config.openApiUrl === undefined);
}

/** TestRun.platforms ⊆ 应用能力集合（建模规则 2）。 */
export function runPlatformsAllowed(run: TestRun, application: Application): boolean {
    const capabilities = new Set(applicationCapabilities(application));
    return run.platforms.every((platform) => capabilities.has(platform));
}

/** 建模规则全量校验：返回违规清单（空数组=合法）。 */
export function validateRunModelingRules(run: TestRun, application: Application): string[] {
    const violations: string[] = [];
    if (!applicationMeetsOpenApiRequirement(application)) {
        violations.push("api application must provide config.openApiUrl");
    }
    const invalidPlatforms = run.platforms.filter(
        (platform) => !PlatformSchema.safeParse(platform).success,
    );
    if (invalidPlatforms.length > 0) {
        violations.push(`unknown platforms: ${invalidPlatforms.join(", ")}`);
    }
    if (!runPlatformsAllowed(run, application)) {
        violations.push(
            `run platforms [${run.platforms.join(", ")}] exceed application capabilities [${applicationCapabilities(application).join(", ")}]`,
        );
    }
    return violations;
}
