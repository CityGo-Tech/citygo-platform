/** @type {import('next').NextConfig} */
const config = {
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
