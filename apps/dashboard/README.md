# @aqaos/dashboard

Next.js (App Router) dashboard for AQAOS — replaces the QA-Swarm static
placeholder (`apps/web`, removed per audit report §3.28).

- Consumes the AQAOS REST API + SSE stream (`AQAOS_API_URL` 服务端 / `NEXT_PUBLIC_API_BASE_URL` 客户端).
- Panels: runs, agent status, approvals, cases & bugs, quality metrics,
  environments.

Status: 骨架（T-E01-10）：布局 + 登录（BFF httpOnly Cookie 会话）+ OpenAPI →
typed client。完整 UI 随 T-E11-02（M1 后段）落地 — design tokens
intentionally mirror the QA-Swarm control-plane theme so the visual language
carries over.

## 登录与会话（T-E01-10）

- 登录：`/login` → BFF `POST /api/auth/login` → 转发 API `/api/v1/auth/login`，
  成功后 JWT 写入 httpOnly Cookie `aqaos_session`（SameSite=Lax，生产 Secure），
  token 不经客户端 JS。
- 保护：`src/middleware.ts` 按 Cookie 存在性快速重定向；凭据有效性由 API 校验，
  数据页 401 时服务端组件再次重定向 `/login`。
- 登出：`POST /api/auth/logout` 清除 Cookie（JWT 无状态，12h TTL 自然过期；
  即时吊销随 T-E11-05 token 版本机制）。

## OpenAPI → typed client

```bash
npm run dev -w @aqaos/api        # 1. 启动 API（4317）
npm run gen:api -w @aqaos/dashboard   # 2. 拉取 /openapi.json 生成 src/lib/api-schema.d.ts
```

生成的 `api-schema.d.ts` 提交入库（CI 构建不依赖运行中的 API）。API 路由或
schema 变更后必须重新生成——openapi-fetch 的 `paths` 泛型使契约漂移在
dashboard 编译期即失败，而非运行时。

## 本地联调

```bash
docker compose -f docker/docker-compose.dev.yml up -d postgres
npm run db:migrate               # 建表
npm run dev -w @aqaos/api        # API :4317
npm run dev -w @aqaos/dashboard  # Dashboard :3400
```

管理员的创建当前经由数据库播种（users.password_hash 为 scrypt PHC 格式，可
用 `apps/api/src/lib/passwords.ts#hashPassword` 生成）；管理界面随 T-E11-05 落地。
