/**
 * Shared Drizzle database handle type used by every drizzle-store method
 * group. Kept in its own module so `converters.ts` and each `*-methods`
 * module can import it without depending on `drizzle-store.ts` itself.
 */

import type { LibSQLDatabase } from "drizzle-orm/libsql";

export type DB = LibSQLDatabase<Record<string, never>>;
