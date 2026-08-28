import { getOwnedProject } from "../core/api.js";
import { loadConfig } from "../core/config.js";
import { loadActiveProject, saveActiveProject, stopActiveProject } from "../core/project-state.js";

export async function startProject(slug: string, log = console.log, errorLog = console.error): Promise<number> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { errorLog("Invalid project slug."); return 1; }
  const config = await loadConfig();
  if (!config) { errorLog("Not logged in. Run `burn login` first."); return 1; }
  try {
    const { project } = await getOwnedProject(config.apiOrigin, config.deviceToken, slug);
    if (!project.public || project.verificationStatus !== "verified") {
      errorLog("Project attribution requires a verified public Burnbook project.");
      return 1;
    }
    const existing = await loadActiveProject();
    if (existing) { errorLog(`Project ${existing.slug} is already active. Run \`burn project stop\` first.`); return 1; }
    await saveActiveProject({ version: 1, projectId: project.id, slug: project.slug, startedAt: new Date().toISOString() });
    log(`Attributing future evidence to ${project.slug}. No repository path, prompt, code, or diff is recorded.`);
    return 0;
  } catch { errorLog("Could not resolve that project from Burnbook."); return 1; }
}

export async function stopProject(log = console.log): Promise<number> {
  const stopped = await stopActiveProject();
  log(stopped ? `Stopped attribution to ${stopped.slug}.` : "No project attribution was active.");
  return 0;
}
