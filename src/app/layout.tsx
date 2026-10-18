import type { Metadata } from "next";
import "./globals.css";

// Root layout: minimal, no client-side font loading blocking first paint
// (uses system font stack below rather than next/font with a remote
// webfont, so content is visible before any font swap -- performance.md).
// Not indexable by default: this app is an authenticated SaaS back office,
// not a marketing site, so SEO is deliberately not optimized here.
export const metadata: Metadata = {
  title: "Gestion commerciale",
  description: "SaaS multi-tenant de gestion commerciale.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {/* Keyboard-accessible skip link (accessibility baseline). */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Aller au contenu principal
        </a>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
