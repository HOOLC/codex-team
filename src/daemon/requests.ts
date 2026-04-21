import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DaemonRequest =
  | {
      id: string;
      created_at: string;
      type: "auth-refresh-now";
      source: string;
    };

function resolveRequestsDir(codexTeamDir: string): string {
  return join(codexTeamDir, "daemon-requests");
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
}

function buildRequestFileName(request: DaemonRequest): string {
  return `${request.created_at.replace(/[:.]/gu, "-")}-${request.id}.json`;
}

function parseRequest(raw: string): DaemonRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.type !== "auth-refresh-now"
    || typeof record.id !== "string"
    || typeof record.created_at !== "string"
    || typeof record.source !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    created_at: record.created_at,
    type: "auth-refresh-now",
    source: record.source,
  };
}

export async function enqueueDaemonRequest(
  codexTeamDir: string,
  request: Omit<DaemonRequest, "id" | "created_at">,
): Promise<DaemonRequest> {
  const materialized: DaemonRequest = {
    ...request,
    id: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
  };
  const requestsDir = resolveRequestsDir(codexTeamDir);
  await ensureDirectory(requestsDir);
  const requestPath = join(requestsDir, buildRequestFileName(materialized));
  await atomicWriteFile(requestPath, `${JSON.stringify(materialized)}\n`);
  return materialized;
}

export async function drainDaemonRequests(codexTeamDir: string): Promise<DaemonRequest[]> {
  const requestsDir = resolveRequestsDir(codexTeamDir);
  let fileNames: string[];
  try {
    fileNames = (await readdir(requestsDir))
      .filter((fileName) => fileName.endsWith(".json") && !fileName.startsWith("."))
      .sort();
  } catch {
    return [];
  }

  const requests: DaemonRequest[] = [];
  for (const fileName of fileNames) {
    const requestPath = join(requestsDir, fileName);
    try {
      const parsed = parseRequest(await readFile(requestPath, "utf8"));
      if (parsed) {
        requests.push(parsed);
      }
    } catch {
      // Ignore malformed or concurrently removed request files.
    } finally {
      await unlink(requestPath).catch(() => undefined);
    }
  }

  return requests;
}
