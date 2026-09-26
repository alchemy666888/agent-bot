import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@vercel/sandbox"],
  outputFileTracingIncludes: {
    "/api/telegram/webhook": ["./dist/worker.mjs"],
  },
  async headers() {
    const shared = [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      {
        key: "Content-Security-Policy",
        value:
          "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ];
    return [
      {
        source: "/login",
        headers: [
          ...shared,
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/dashboard",
        headers: [...shared, { key: "Referrer-Policy", value: "same-origin" }],
      },
      {
        source: "/dashboard/:path*",
        headers: [...shared, { key: "Referrer-Policy", value: "same-origin" }],
      },
    ];
  },
};

export default nextConfig;
