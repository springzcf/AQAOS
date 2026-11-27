# @aqaos/dashboard

Next.js (App Router) dashboard for AQAOS — replaces the QA-Swarm static
placeholder (`apps/web`, removed per audit report §3.28).

- Consumes the AQAOS REST API + SSE stream (`NEXT_PUBLIC_API_BASE_URL`).
- Panels: runs, agent status, approvals, cases & bugs, quality metrics,
  environments.

Status: skeleton (T-E01-01). Full UI lands with T-E11-02 (M1 后段) —
design tokens intentionally mirror the QA-Swarm control-plane theme so the
visual language carries over.
