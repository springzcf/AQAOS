/**
 * vitest 全局兜底（T-E02-03 依赖树重装后引入）：
 * vitest 2.1.9 的 worker 沙箱不含全局 WebCrypto（Node 18 环境），
 * 而 jose（JWT 签发/校验）的 webapi 构建裸引用 `crypto`。
 * Node ≥19 与 forks 池均有该全局，此 polyfill 仅在缺失时补位。
 */

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
    // node:crypto 的 webcrypto 与 WebCrypto API 同构；类型经收窄对齐。
    globalThis.crypto = webcrypto as unknown as Crypto;
}
