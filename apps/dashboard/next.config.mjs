/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard consumes the AQAOS API (apps/api) and its SSE stream.
  // Server-side calls go through the internal service URL; nothing is
  // exposed publicly except the UI itself.
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4317",
  },
};

export default nextConfig;
