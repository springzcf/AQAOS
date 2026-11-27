export default function HomePage() {
    const panels = [
        {
            title: "运行（Runs）",
            detail: "运行列表、状态机、实时日志（SSE）",
            epic: "T-E02-09 / T-E11-02",
        },
        {
            title: "Agent 状态",
            detail: "16 个 agent 三分类：会话型 / 混合型 / 程序型",
            epic: "T-E02-04 / T-E03-*",
        },
        { title: "审批中心", detail: "L3 自主级的审批请求与超时策略（FR-011）", epic: "T-E06-*" },
        {
            title: "用例与缺陷",
            detail: "用例库、缺陷双向同步、PR check 回写",
            epic: "T-E07 / T-E08",
        },
        { title: "质量看板", detail: "质量指标与反馈闭环（FR-028）", epic: "T-E12-*" },
        {
            title: "环境管理",
            detail: "Compose 环境栈、播种与重置（DDD §12）",
            epic: "environment epic (M2)",
        },
    ];

    return (
        <div className="grid">
            {panels.map((p) => (
                <section key={p.title} className="card">
                    <h2>{p.title}</h2>
                    <p>{p.detail}</p>
                    <footer>{p.epic}</footer>
                </section>
            ))}
        </div>
    );
}
