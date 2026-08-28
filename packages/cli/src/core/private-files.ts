import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lexical = await fs.lstat(directory);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new Error("Burnbook's local state directory must not be a symlink.");
  }
  await fs.chmod(directory, 0o700);
}

export async function readPrivateFile(filePath: string, maxBytes = 64 * 1024): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Burnbook's local state file must be a regular file.");
    if (stat.size > maxBytes) throw new Error("Burnbook's local state file exceeds its safety limit.");
    return await handle.readFile("utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.burnbook-${process.pid}-${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await fs.unlink(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code));
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
