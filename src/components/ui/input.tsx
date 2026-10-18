import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

// 44px tall by default -- comfortable thumb target and legible without
// zooming on a small Android screen.
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "h-touch w-full rounded-md border border-input bg-background px-3 text-base placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
