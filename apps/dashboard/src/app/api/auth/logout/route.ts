/**
 * 登出 BFF（T-E01-10）：清除会话 Cookie。
 * 服务端撤销可选：JWT 无状态（12h TTL 自然过期）；若需立即吊销，调用方可
 * 自行 DELETE 自己的 API Token 或等 T-E11-05 的 token 版本号机制落地。
 */

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST() {
    const response = NextResponse.json({ ok: true });
    response.cookies.delete(SESSION_COOKIE);
    return response;
}
