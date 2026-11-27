"use client";

/**
 * 登录页（T-E01-10）：邮箱+密码 → BFF /api/auth/login（httpOnly Cookie 会话）。
 * 错误展示 API 原文（防枚举统一口径 "Invalid email or password"）。
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface ErrorBody {
    error?: { code?: string; message?: string };
}

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            if (response.ok) {
                router.replace("/");
                router.refresh();
                return;
            }
            const body = (await response.json().catch(() => null)) as ErrorBody | null;
            setError(body?.error?.message ?? `登录失败（HTTP ${response.status}）`);
        } catch {
            setError("无法连接控制面服务，请确认 API 已启动");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="login-wrap">
            <form className="card login-card" onSubmit={onSubmit}>
                <h2>登录 AQAOS 控制台</h2>
                <label>
                    邮箱
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="username"
                        required
                    />
                </label>
                <label>
                    密码
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </label>
                {error !== null && <p className="login-error">{error}</p>}
                <button type="submit" disabled={submitting}>
                    {submitting ? "登录中…" : "登录"}
                </button>
            </form>
        </div>
    );
}
