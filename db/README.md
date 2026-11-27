# db/ — Schema 迁移（T-E01-07）

33 张核心表的 Flyway 风格迁移目录（DDL 唯一事实源：`docs/03-详细设计说明书.md` §7.2/§7.3）。

## 布局

```
db/
  enum-dictionary.ts   # DDD §7.3 枚举字典（CHECK 约束与 zod 的单一代码源）
  runner.ts            # up/down + checksum 防篡改 + pg_advisory_lock 互斥
  migrate.ts           # CLI 入口（tsx 运行）
  migrations/          # NNNN_领域.ts，默认导出 satisfies Migration
  tsconfig.json        # 独立 typecheck（npm run typecheck 覆盖）
```

## 常用命令

```bash
make dev                        # 启动 postgres(pgvector) 等开发依赖
npm run db:migrate              # 空库一键建表（全部待执行迁移）
npm run db:status               # 已应用 / 待执行
npm run db:rollback             # 回滚最近 1 个（可用 -- all 回滚全部）
npm run db:reset                # 回滚全部后重新应用（拒绝在生产执行）
npm run test:db                 # 迁移测试（scratch 库：建库→up→断言→down→up）
```

## 新增迁移约定

1. 文件名 `NNNN_领域.ts`（编号递增，禁止复用已应用的编号）；
2. `export default { name, description, up, down } satisfies Migration`；
3. 枚举列的 CHECK 一律经 `enumChecksForTable("表名")` 生成（先在 `enum-dictionary.ts`
   登记 `ENUM_COLUMN_BINDINGS`）；
4. down 必须可用（`DROP TABLE IF EXISTS ... CASCADE`）；禁止修改已应用迁移——checksum
   校验会直接报错，只能新增迁移；
5. 语句数组内不含 `$1` 占位符与 BEGIN/COMMIT（runner 负责事务与登记）。

## 租户隔离（RLS 骨架，0005）

- 会话查询租户数据前执行 `SET aqaos.organization_id = '<uuid>'`；
- 未设置 → 行不可见、写入被拒（fail-closed）；
- 子表与全局表的 RLS、`FORCE ROW LEVEL SECURITY`、应用角色授权：M2 租户加固（T-E11-05）。

## CI

`ci.yml` 的 `migrate` job：pgvector/pg16 service → `npm run test:db`
（建 scratch 库 → up → 33 表/RLS/枚举断言 → down 清空 → 再 up）。
