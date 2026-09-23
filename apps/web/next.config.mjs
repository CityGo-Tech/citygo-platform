import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  // Opt-in on the Linux image builder; keep existing local/Windows workflows.
  output: process.env.CITYGO_WEB_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  transpilePackages: [
    "@citygo/contracts",
    "@citygo/ui-web",
    "@citygo/api-client",
  ],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination:
          (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000") + "/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
