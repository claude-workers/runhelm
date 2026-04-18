// Read-only access to the self-project row. Separated from self-project.ts
// to avoid a circular import: self-project.ts (ensureSelfProject) pulls in
// channels/index.ts, which in turn pulls in telegram/matrix — both of which
// need to read the self-project for admin-room checks. This file only
// depends on the DB module, so it can be imported from anywhere.
import { db } from "./db.js";
import type { Project } from "./workers.js";

export function getSelfProject(): Project | null {
  return (
    (db
      .prepare("SELECT * FROM projects WHERE is_self = 1 LIMIT 1")
      .get() as Project | undefined) ?? null
  );
}
