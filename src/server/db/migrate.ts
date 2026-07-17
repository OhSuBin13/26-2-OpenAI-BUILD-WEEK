import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

const db = createDb(process.env.DATABASE_URL!);

try {
  await migrate(db, { migrationsFolder: "drizzle" });
} finally {
  await db.$client.end();
}
