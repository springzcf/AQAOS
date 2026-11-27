import express from "express";
import {
    computeTotal,
    fixedTokens,
    products,
    publicUser,
    seedOrders,
    seedUsers,
    type Order,
    type User,
} from "./data.js";

/**
 * AQAOS 评测靶标（T-E01-06，演进自 QA-Swarm demo-app）。
 *
 * 故意携带 8 个真实可发现缺陷（完整清单见 known-bugs.json）：
 *  1. /login 已知邮箱任意密码即可登录（auth bypass）
 *  2. /api/users 泄漏 passwordHash（数据暴露）
 *  3. /search 反射型 XSS
 *  4. 全站缺失安全响应头
 *  5. /api/slow 1.5s 人为延迟（性能预算超限）
 *  6. /api/orders 不校验角色：viewer 也可下单（越权）
 *  7. /api/orders/:id 不校验归属（IDOR）
 *  8. /api/orders 订单总额漏算税费（业务规则缺陷）
 *
 * DO NOT copy this into a real project.
 */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// BUG 4: 安全响应头从不设置（CSP/HSTS/X-Frame-Options 等全缺）。

// --- 会话（固定令牌，确定性评测） ------------------------------------------

interface Session {
    userId: number;
    role: User["role"];
}
const sessions = new Map<string, Session>();
for (const [token, userId] of Object.entries(fixedTokens)) {
    const user = seedUsers.find((u) => u.id === userId);
    if (user) sessions.set(token, { userId, role: user.role });
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            session?: Session;
        }
    }
}

app.use((req, _res, next) => {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const token = bearer ?? (req.headers.cookie ?? "").match(/session=(\S+)/)?.[1];
    if (token) req.session = sessions.get(token);
    next();
});

// --- 页面 -------------------------------------------------------------------

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto; padding: 0 20px">
    <nav><a href="/">Home</a> · <a href="/login">Login</a> · <a href="/search">Search</a> · <a href="/users">Users</a></nav>
    <h1>${title}</h1>
    ${body}
  </body>
</html>`;

app.get("/", (_req, res) => {
    res.send(
        page(
            "Demo Shop",
            `<p>Welcome to the AQAOS demo target.</p>
    <form action="/search" method="get">
      <label for="q">Search products</label>
      <input id="q" name="q" placeholder="e.g. laptop" />
      <button type="submit">Search</button>
    </form>`,
        ),
    );
});

app.get("/login", (_req, res) => {
    res.send(
        page(
            "Login",
            `<form id="login-form" action="/login" method="post">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required />
    <button type="submit">Sign in</button>
  </form>`,
        ),
    );
});

app.post("/login", (req, res) => {
    const { email } = req.body ?? {};
    // BUG 1: 已知邮箱任意密码即可登录（auth bypass）。
    const user = seedUsers.find((u) => u.email === email);
    if (user) {
        const token = `tok-${user.role}-${String(user.id).padStart(3, "0")}`;
        sessions.set(token, { userId: user.id, role: user.role });
        res.setHeader("set-cookie", `session=${token}; Path=/`);
        return res.json({ ok: true, token, user: publicUser(user) });
    }
    res.status(401).json({ ok: false, error: "invalid credentials" });
});

app.get("/search", (req, res) => {
    const q = String(req.query.q ?? "");
    // BUG 3: 反射型 XSS — q 未转义直接内插。
    res.send(
        page(
            "Search results",
            `<p>Results for: ${q}</p>
    <ul><li>Laptop Pro — $1299</li><li>Laptop Air — $999</li></ul>`,
        ),
    );
});

app.get("/users", (req, res) => {
    // BUG 6 的页面侧：仅要求"已登录"，不校验 admin 角色。
    if (!req.session) {
        return res.status(401).send(page("Login", `<p role="alert">Sign in required</p>`));
    }
    res.send(
        page(
            "Users",
            `<table id="users"><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${seedUsers
                .map((u) => {
                    const p = publicUser(u);
                    return `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.email}</td><td>${p.role}</td></tr>`;
                })
                .join("")}</tbody></table>`,
        ),
    );
});

// --- API --------------------------------------------------------------------

app.get("/api/users", (_req, res) => {
    // BUG 2: 直接返回完整对象，泄漏 passwordHash。
    res.json(seedUsers);
});

app.get("/api/products", (_req, res) => {
    res.json(products);
});

app.get("/api/products/:id", (req, res) => {
    const p = products.find((x) => x.id === Number(req.params.id));
    if (!p) return res.status(404).json({ error: "product not found" });
    res.json(p);
});

const orders: Order[] = [...seedOrders];

app.post("/api/orders", (req, res) => {
    // BUG 6: 任何已登录角色（含 viewer）都能创建订单。
    if (!req.session) return res.status(401).json({ error: "login required" });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    const valid =
        items &&
        items.every(
            (it: { productId?: number; qty?: number }) =>
                Number.isInteger(it?.productId) && (it?.qty ?? 0) > 0,
        );
    if (!valid) return res.status(400).json({ error: "items[] with productId/qty required" });
    const order: Order = {
        id: 1000 + orders.length + 1,
        userId: req.session.userId,
        items,
        total: computeTotal(items), // BUG 8: 漏算税费。
        createdAt: new Date().toISOString(),
    };
    orders.push(order);
    res.status(201).json(order);
});

app.get("/api/orders/:id", (req, res) => {
    if (!req.session) return res.status(401).json({ error: "login required" });
    const order = orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: "order not found" });
    // BUG 7: 不校验订单归属（IDOR）——任何登录用户可读他人订单。
    res.json(order);
});

app.get("/api/slow", async (_req, res) => {
    // BUG 5: 1.5s 人为延迟（超出默认 TTFB 预算 800ms）。
    await new Promise((r) => setTimeout(r, 1500));
    res.json({ ok: true, note: "this endpoint is intentionally slow" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 4318);
app.listen(port, () => {
    console.log(`demo app (aqaos evaluation target) on http://localhost:${port}`);
});
