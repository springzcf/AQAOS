/**
 * 0006 认证基座（T-E01-09，DDD V1.5 增补）。
 *
 * users.password_hash：本地认证（auth_provider='local'）的 scrypt PHC 格式哈希；
 * SSO 用户为 NULL——登录路由对 NULL 直接拒绝，永远不与空串比较成功。
 *
 * api_tokens：API Token（明文仅创建时返回一次，库内只存 sha256 十六进制）。
 * 撤销语义 = revoked_at 置位（Token 可撤销验收项）；token_prefix 供 UI 识别
 * "最后四位"风格展示；last_used_at 由 API 层节流更新（≥60s 才写，避免逐请求写放大）。
 * 作用域为 user_id（非租户表），RLS 随 M2 用户级策略（T-E11-05）另行设计。
 */

import type { Migration } from "../runner.js";

export default {
    name: "0006_auth",
    description:
        "users.password_hash（scrypt，可空）+ api_tokens 表（sha256 存储/前缀识别/软撤销）",
    up: [
        `ALTER TABLE users ADD COLUMN password_hash TEXT`,
        `CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)`,
        `CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id)`,
        `COMMENT ON COLUMN users.password_hash IS
  'scrypt PHC 格式（scrypt$N$r$p$salt_b64$hash_b64）；SSO 用户为 NULL，登录对 NULL 恒拒绝'`,
        `COMMENT ON TABLE api_tokens IS
  'API Token：sha256(token) 唯一存储，明文仅创建响应返回一次；revoked_at 置位即撤销；expires_at 可选过期'`,
    ],
    down: [
        `DROP TABLE IF EXISTS api_tokens`,
        `ALTER TABLE users DROP COLUMN IF EXISTS password_hash`,
    ],
} satisfies Migration;
