// M7 (security-reviewer finding): baseline security headers. Next.js sets
// none of these by default -- they have to be added explicitly. Applied to
// every route (`source: "/:path*"`).
//
// Content-Security-Policy is NOT set here: it's nonce-based and generated
// per-request in src/middleware.ts instead. Next.js's App Router injects
// inline <script> tags for RSC streaming/hydration on every page; a static
// `script-src 'self'` with no nonce blocks all of them, so React never
// hydrates (forms/buttons silently stop working). Next automatically applies
// the middleware's nonce to its own inline scripts when it's present in the
// CSP response header -- that's the officially documented pattern, see
// src/middleware.ts for the actual policy.
const securityHeaders = [
  // HSTS: only meaningful over HTTPS (Vercel terminates TLS in front of this
  // app), but harmless to always send. 2 years + preload, per current best
  // practice for a production domain that will always be HTTPS.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Belt-and-suspenders with CSP's frame-ancestors (older browsers that
  // don't support frame-ancestors still respect X-Frame-Options).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Images: next/image already compresses/resizes and serves AVIF/WebP by
  // default (performance.md: mobile-first, slow-network images). No remote
  // domains whitelisted yet -- business modules will add Supabase Storage
  // signed-URL hosts here once file uploads exist.
  images: {
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
