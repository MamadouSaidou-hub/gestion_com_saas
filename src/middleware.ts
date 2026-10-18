import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Per-request CSP nonce. Next.js's App Router reads the nonce back out of
// the Content-Security-Policy response header and automatically applies it
// to its own inline hydration/RSC-streaming <script> tags -- without this,
// `script-src 'self'` (no 'unsafe-inline') blocks every one of those inline
// scripts and the page never hydrates (buttons/forms silently do nothing).
// This is the official Next.js-documented pattern for strict CSP + App Router.
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // `next dev`'s webpack runtime uses eval() for HMR/React Refresh -- without
  // 'unsafe-eval' in dev, the ENTIRE client bundle throws on load and React
  // never hydrates (forms silently fall back to native GET submission,
  // leaking the password into the URL/server logs -- exactly what happened
  // before this fix). Production builds (`next build`/`next start`) don't use
  // eval(), so 'unsafe-eval' is correctly omitted there.
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const contentSecurityPolicy = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets and image optimization requests.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
