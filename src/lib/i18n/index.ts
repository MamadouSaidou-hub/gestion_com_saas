import { fr } from "./fr";

// Only FR is implemented for now (CLAUDE.md: "FR now, EN later"). Swapping
// in an `en.ts` dictionary and a real locale resolver (cookie / Accept-
// Language) later is additive -- no component should import `fr` directly.
export const dict = fr;
