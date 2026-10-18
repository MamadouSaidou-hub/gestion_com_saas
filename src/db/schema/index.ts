// Barrel export — aggregates every module so drizzle-kit (schema: "./src/db/schema/index.ts")
// and app code can import the whole schema from one place, while the source
// stays split by module boundary (tenancy / catalog / inventory / sales /
// billing / audit) rather than one giant schema.ts file.

export * from "./tenancy";
export * from "./catalog";
export * from "./inventory";
export * from "./sales";
export * from "./billing";
export * from "./stock-transfers";
export * from "./audit";
