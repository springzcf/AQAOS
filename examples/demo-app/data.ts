/**
 * AQAOS 评测靶标种子数据（T-E01-06）。
 *
 * 确定性种子：不随机、不漂移——同一份数据支撑：
 *  - E2E 固定断言（tests/e2e）
 *  - Agent 评测基线（Golden Dataset，T-E02-13）
 *  - 已知缺陷的可复现验证（known-bugs.json）
 *
 * 三级角色：admin / user / viewer（期望权限递减；其中若干端点故意不校验，
 * 见 known-bugs.json BUG-06/07）。
 */

export interface User {
    id: number;
    name: string;
    email: string;
    role: "admin" | "user" | "viewer";
    /** 仅内部使用；泄漏到 API 响应即为 BUG-02。 */
    passwordHash: string;
}

export interface Product {
    id: number;
    name: string;
    price: number;
    category: "laptop" | "accessory";
}

export interface Order {
    id: number;
    userId: number;
    items: { productId: number; qty: number }[];
    /** 期望值 = Σ qty×price；当前实现漏算税费 → BUG-08。 */
    total: number;
    createdAt: string;
}

export const seedUsers: User[] = [
    {
        id: 1,
        name: "Ada Lovelace",
        email: "admin@example.com",
        role: "admin",
        passwordHash: "sha256:deadbeef",
    },
    {
        id: 2,
        name: "Alan Turing",
        email: "user@example.com",
        role: "user",
        passwordHash: "sha256:cafebabe",
    },
    {
        id: 3,
        name: "Grace Hopper",
        email: "viewer@example.com",
        role: "viewer",
        passwordHash: "sha256:feedface",
    },
];

export const products: Product[] = [
    { id: 1, name: "Laptop Pro", price: 1299, category: "laptop" },
    { id: 2, name: "Laptop Air", price: 999, category: "laptop" },
    { id: 3, name: "USB-C Dock", price: 189, category: "accessory" },
    { id: 4, name: "Wireless Mouse", price: 49, category: "accessory" },
    { id: 5, name: "Mechanical Keyboard", price: 129, category: "accessory" },
];

export const seedOrders: Order[] = [
    {
        id: 1001,
        userId: 1,
        items: [{ productId: 1, qty: 1 }],
        total: 1299,
        createdAt: "2026-11-01T09:00:00.000Z",
    },
    {
        id: 1002,
        userId: 2,
        items: [
            { productId: 3, qty: 2 },
            { productId: 4, qty: 1 },
        ],
        total: 427,
        createdAt: "2026-11-12T14:30:00.000Z",
    },
];

/** 固定会话令牌（确定性，评测用）：角色名 + 序号。 */
export const fixedTokens: Record<string, number> = {
    "tok-admin-001": 1,
    "tok-user-001": 2,
    "tok-viewer-001": 3,
};

export function publicUser(u: User): Omit<User, "passwordHash"> {
    return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export function computeTotal(items: { productId: number; qty: number }[]): number {
    // BUG-08（故意）：漏算税费（期望含 8% 税），使"业务规则断言"型用例可稳定失败。
    return items.reduce((sum, it) => {
        const p = products.find((x) => x.id === it.productId);
        return sum + (p ? p.price * it.qty : 0);
    }, 0);
}
