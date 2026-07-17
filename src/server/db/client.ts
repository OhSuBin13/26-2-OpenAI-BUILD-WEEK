import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 5 });
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>;
