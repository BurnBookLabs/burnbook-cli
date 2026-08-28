import * as path from "node:path";
import { z } from "zod";
import { configDir } from "./paths.js";
import { readPrivateFile, writePrivateFile } from "./private-files.js";

const schema = z.object({
  version: z.literal(1),
  projectId: z.string().uuid(),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  startedAt: z.string().datetime({ offset: true }),
}).strict();

export type ActiveProject = z.infer<typeof schema>;

export async function loadActiveProject(): Promise<ActiveProject | undefined> {
  const value = await readPrivateFile(path.join(configDir(), "active-project.json"), 4096);
  if (!value) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export async function saveActiveProject(project: ActiveProject): Promise<void> {
  await writePrivateFile(path.join(configDir(), "active-project.json"), `${JSON.stringify(schema.parse(project))}\n`);
}

export async function stopActiveProject(): Promise<ActiveProject | undefined> {
  const active = await loadActiveProject();
  try {
    const { promises: fs } = await import("node:fs");
    await fs.unlink(path.join(configDir(), "active-project.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return active;
}
