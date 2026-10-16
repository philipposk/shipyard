import type { NextConfig } from "next";

// Private app (scaffold --private sets NEXT_PUBLIC_SITE_PRIVATE=true): search engines are told to skip every page.
const SITE_PRIVATE = process.env.NEXT_PUBLIC_SITE_PRIVATE === "true";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Turn these on per feature when the app really needs them (for example microphone=(self)).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SITE_PRIVATE
          ? [...securityHeaders, { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }]
          : securityHeaders,
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
};

export default nextConfig;
