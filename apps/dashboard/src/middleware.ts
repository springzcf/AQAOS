/**
 * 未登录访问保护（T-E01-10）。
 * 仅检查 Cookie 存在性（快速重定向）；凭据有效性由 API 端校验——
 * 过期/无效 token 访问数据页时，服务端组件收到 401 后再次重定向到 /login。
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export function middleware(request: NextRequest) {
    const hasSession = request.cookies.has(SESSION_COOKIE);
    if (hasSession) {
        return NextResponse.next();
    }
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/login") || pathname.startsWith("/api/auth")) {
        return NextResponse.next();
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
