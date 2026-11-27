import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
    title: "AQAOS — Autonomous QA Operating System",
    description:
        "AQAOS control plane: runs, agents, approvals, reports, and quality metrics for the autonomous QA platform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="zh-CN">
            <body>
                <header className="topbar">
                    <div className="logo">AQ</div>
                    <h1>AQAOS 控制台</h1>
                    <span className="tag">skeleton · T-E01-10</span>
                </header>
                <main>{children}</main>
            </body>
        </html>
    );
}
