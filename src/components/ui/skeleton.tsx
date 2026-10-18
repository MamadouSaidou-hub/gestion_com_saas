import { cn } from "@/lib/utils";

// Perceived-performance helper for slow networks: render a skeleton instead
// of a blank screen while a slow 3G round trip resolves. Respects
// prefers-reduced-motion globally via globals.css (animation-duration
// collapses to ~0 there).
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
