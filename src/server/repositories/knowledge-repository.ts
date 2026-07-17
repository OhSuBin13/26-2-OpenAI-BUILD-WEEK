import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { knowledgeSources } from "../db/schema";

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  listProjectSources(projectKey: string) {
    return this.db.select().from(knowledgeSources).where(eq(knowledgeSources.projectKey, projectKey));
  }
}
