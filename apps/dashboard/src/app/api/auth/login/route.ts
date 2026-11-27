/**
 * 登录 BFF（T-E01-10）：代理 Control Plane API /api/v1/auth/login，
 * 成功后把 JWT 写入 httpOnly Cookie（token 不经客户端 JS）。
 * API 错误信封原样转发（401/403/400 → 前端展示对应消息）。
 */

import { NextResponse, type NextRequest } from "next/server";
import { API_BASE_URL } from "@/lib/api";
import { SESSION_COOKIE, sessionCookieOptions, validateLoginPayload } from "@/lib/session";

export async function POST(request: NextRequest) {
    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return NextResponse.json(
            { error: { code: "VALIDATION_FAILED", message: "Request body must be JSON" } },
            { status: 400 },
        );
    }
    const validated = validateLoginPayload(payload);
    if (!validated) {
        return NextResponse.json(
            { error: { code: "VALIDATION_FAILED", message: "email and password are required" } },
            { status: 400 },
        );
    }

    const upstream = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validated),
    });
    const body = (await upstream.json().catch(() => null)) as {
        token?: string;
        user?: unknown;
        organizationId?: string | null;
        role?: string;
    } | null;

    if (!upstream.ok || typeof body?.token !== "string") {
        return NextResponse.json(
            body ?? { error: { code: "INTERNAL_ERROR", message: "Login failed" } },
            {
                status: upstream.status,
            },
        );
    }

    const response = NextResponse.json({
        ok: true,
        user: body.user,
        organizationId: body.organizationId ?? null,
        role: body.role ?? "none",
    });
    response.cookies.set(
        SESSION_COOKIE,
        body.token,
        sessionCookieOptions(process.env.NODE_ENV === "production"),
    );
    return response;
}
