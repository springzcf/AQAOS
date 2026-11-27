/**
 * 控制台首页（T-E01-10）：服务端组件经类型化客户端读取 /users/me 与 /runs。
 * Cookie 过期/无效（API 401）→ 重定向 /login；登出为原生表单 POST /api/auth/logout。
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { apiClient } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";

interface Profile {
    id: string;
    email: string;
    displayName: string | null;
    activeOrganizationId: string | null;
    activeRole: string;
    credentialsVia: string;
    memberships: Array<{ organizationId: string; organizationName: string; role: string }>;
}

const EPIC_PANELS = [
    {
        title: "Agent 状态",
        detail: "16 个 agent 三分类：会话型 / 混合型 / 程序型",
        epic: "T-E02-04 / T-E03-*",
    },
    { title: "审批中心", detail: "L3 自主级的审批请求与超时策略（FR-011）", epic: "T-E06-*" },
    { title: "用例与缺陷", detail: "用例库、缺陷双向同步、PR check 回写", epic: "T-E07 / T-E08" },
    { title: "质量看板", detail: "质量指标与反馈闭环（FR-028）", epic: "T-E12-*" },
    {
        title: "环境管理",
        detail: "Compose 环境栈、播种与重置（DDD §12）",
        epic: "environment epic (M2)",
    },
];

export default async function HomePage() {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) {
        redirect("/login");
    }

    const client = apiClient(token);
    const me = await client.GET("/api/v1/users/me");
    if (me.response.status === 401) {
        // Cookie 存在但凭据已失效（JWT 过期/被吊销）。
        redirect("/login");
    }
    const profile = me.data as Profile | undefined;

    const runs = await client.GET("/api/v1/runs");

    return (
        <div className="stack">
            <section className="card">
                <h2>当前账户</h2>
                {profile ? (
                    <dl className="profile">
                        <div>
                            <dt>邮箱</dt>
                            <dd>{profile.email}</dd>
                        </div>
                        <div>
                            <dt>角色</dt>
                            <dd>
                                {profile.activeRole}
                                <span className="muted">（凭据 {profile.credentialsVia}）</span>
                            </dd>
                        </div>
                        <div>
                            <dt>所属组织</dt>
                            <dd>
                                {profile.memberships.length === 0
                                    ? "—"
                                    : profile.memberships
                                          .map((m) => `${m.organizationName}（${m.role}）`)
                                          .join("、")}
                            </dd>
                        </div>
                    </dl>
                ) : (
                    <p>无法加载账户信息（API 异常）</p>
                )}
                <form action="/api/auth/logout" method="post">
                    <button type="submit" className="secondary">
                        退出登录
                    </button>
                </form>
            </section>

            <section className="card">
                <h2>运行（Runs）</h2>
                <p>
                    {runs.data
                        ? `共 ${runs.data.total} 条运行记录${(runs.data.items?.length ?? 0) === 0 ? "（Run Registry 随 T-E02-12 落地）" : ""}`
                        : "运行数据不可用"}
                </p>
                <footer>T-E02-09 / T-E11-02</footer>
            </section>

            <div className="grid">
                {EPIC_PANELS.map((p) => (
                    <section key={p.title} className="card">
                        <h2>{p.title}</h2>
                        <p>{p.detail}</p>
                        <footer>{p.epic}</footer>
                    </section>
                ))}
            </div>
        </div>
    );
}
