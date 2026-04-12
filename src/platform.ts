import { readFile } from "node:fs/promises";

export type CodexmPlatform = "darwin" | "linux" | "wsl";

let cachedPlatform: CodexmPlatform | null = null;

/**
 * Detect the current platform, distinguishing between macOS, native Linux,
 * and Windows Subsystem for Linux (WSL).
 *
 * WSL is detected by reading /proc/version and looking for "microsoft" or
 * "WSL" in the kernel version string — a technique endorsed by Microsoft's
 * own documentation.
 */
export async function getPlatform(): Promise<CodexmPlatform> {
  if (cachedPlatform !== null) {
    return cachedPlatform;
  }

  const detected = await detectPlatform();
  cachedPlatform = detected;
  return detected;
}

async function detectPlatform(): Promise<CodexmPlatform> {
  if (process.platform === "darwin") {
    return "darwin";
  }

  if (process.platform !== "linux") {
    // Treat all other platforms (e.g. win32) as linux for now.
    return "linux";
  }

  // On Linux, distinguish native Linux from WSL.
  try {
    const procVersion = await readFile("/proc/version", "utf-8");
    if (/microsoft|wsl/i.test(procVersion)) {
      return "wsl";
    }
  } catch {
    // /proc/version unreadable — assume native Linux.
  }

  return "linux";
}

/**
 * Reset the cached platform. Useful for testing.
 */
export function resetPlatformCache(): void {
  cachedPlatform = null;
}

/**
 * Override the platform for testing. Returns a cleanup function.
 */
export function setPlatformForTesting(platform: CodexmPlatform): () => void {
  const previous = cachedPlatform;
  cachedPlatform = platform;
  return () => {
    cachedPlatform = previous;
  };
}

// ── Codex binary resolution ──

const CODEX_BINARY_NAME_DARWIN = "/Contents/MacOS/Codex";
const CODEX_BINARY_NAME_LINUX = "codex";

/**
 * Return the binary path suffix used to identify a Codex process on the
 * current platform.
 */
export function getCodexBinarySuffix(platform: CodexmPlatform): string {
  return platform === "darwin" ? CODEX_BINARY_NAME_DARWIN : CODEX_BINARY_NAME_LINUX;
}

/**
 * Check whether a process command string looks like a Codex Desktop process
 * on the given platform.
 */
export function isCodexDesktopCommand(command: string, platform: CodexmPlatform): boolean {
  if (platform === "darwin") {
    return command.includes(CODEX_BINARY_NAME_DARWIN);
  }
  // On Linux/WSL, the Electron binary is typically just called "codex"
  // and launched from an installed path.
  const basename = command.split("/").pop()?.split(" ")[0] ?? "";
  return basename === CODEX_BINARY_NAME_LINUX || command.includes("/codex ");
}

/**
 * Check whether a process command string looks like a Codex CLI process
 * (non-Desktop, terminal-based).
 */
export function isCodexCliCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/);
  const binary = parts[0]?.split("/").pop() ?? "";
  // "codex" without "--remote-debugging-port" is likely CLI mode
  return (
    binary === "codex" &&
    !command.includes("--remote-debugging-port")
  );
}
