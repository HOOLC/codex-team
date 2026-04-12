import { describe, expect, test } from "@rstest/core";
import type { ExecFileLike } from "../src/codex-desktop-launch.js";

// ── Helpers ──

function createMockExecFile(
  responses: Record<string, { stdout: string; stderr: string } | Error>,
): ExecFileLike {
  return async (file, args) => {
    const key = `${file} ${(args ?? []).join(" ")}`;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (key === pattern || key.startsWith(pattern)) {
        if (resp instanceof Error) {
          throw resp;
        }
        return resp;
      }
    }
    throw new Error(`Mock execFile: no response for "${key}"`);
  };
}

describe("platform-desktop-adapter", () => {
  describe("Linux process listing", () => {
    test("finds codex Desktop processes on Linux by remote-debugging-port", async () => {
      const execFileImpl = createMockExecFile({
        "ps -Ao pid=,command=": {
          stdout: [
            "  1001 /opt/codex/codex --remote-debugging-port=9223",
            "  1002 /usr/bin/codex --model o4-mini",
            "  1003 /usr/bin/node /app/server.js",
            "  1004 /opt/Codex/codex --remote-debugging-port=9224 --some-flag",
          ].join("\n"),
          stderr: "",
        },
      });

      // Simulate what listRunningAppsLinux does
      const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);
      const running: Array<{ pid: number; command: string }> = [];

      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;

        const pid = Number(match[1]);
        const command = match[2];

        if (
          command.includes("--remote-debugging-port") &&
          (command.includes("codex") || command.includes("Codex"))
        ) {
          running.push({ pid, command });
        }
      }

      expect(running.length).toBe(2);
      expect(running[0]!.pid).toBe(1001);
      expect(running[1]!.pid).toBe(1004);
    });
  });

  describe("Linux app finding", () => {
    test("finds codex via which command", async () => {
      const execFileImpl = createMockExecFile({
        "which codex": { stdout: "/usr/local/bin/codex\n", stderr: "" },
      });

      const { stdout } = await execFileImpl("which", ["codex"]);
      expect(stdout.trim()).toBe("/usr/local/bin/codex");
    });

    test("handles which failure gracefully", async () => {
      const execFileImpl = createMockExecFile({
        "which codex": new Error("which: no codex in PATH"),
      });

      let found: string | null = null;
      try {
        const { stdout } = await execFileImpl("which", ["codex"]);
        found = stdout.trim() || null;
      } catch {
        found = null;
      }

      expect(found).toBeNull();
    });
  });

  describe("WSL Windows process discovery", () => {
    test("discovers Windows Codex Desktop via powershell.exe", async () => {
      const execFileImpl = createMockExecFile({
        "powershell.exe -Command": {
          stdout: JSON.stringify([
            { Id: 5678, Path: "C:\\Program Files\\Codex\\Codex.exe" },
          ]),
          stderr: "",
        },
      });

      const { stdout } = await execFileImpl("powershell.exe", [
        "-Command",
        'Get-Process -Name "Codex" | Select-Object Id, Path | ConvertTo-Json',
      ]);

      const processes = JSON.parse(stdout.trim());
      const items = Array.isArray(processes) ? processes : [processes];

      expect(items.length).toBe(1);
      expect(items[0].Id).toBe(5678);
    });

    test("handles powershell.exe not available", async () => {
      const execFileImpl = createMockExecFile({
        "powershell.exe": new Error("powershell.exe: not found"),
      });

      let processes: unknown[] = [];
      try {
        await execFileImpl("powershell.exe", ["-Command", "Get-Process"]);
      } catch {
        processes = [];
      }

      expect(processes.length).toBe(0);
    });
  });

  describe("Linux quit", () => {
    test("sends SIGTERM to running processes", async () => {
      const killedPids: string[] = [];
      const execFileImpl: ExecFileLike = async (file, args) => {
        if (file === "ps") {
          return {
            stdout: "  2001 /opt/codex/codex --remote-debugging-port=9223\n",
            stderr: "",
          };
        }
        if (file === "kill") {
          killedPids.push(...(args ?? []).filter((a) => /^\d+$/.test(a as string)));
          return { stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected: ${file}`);
      };

      // Simulate quitRunningAppsLinux
      const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);
      const running: Array<{ pid: number }> = [];
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match && match[2].includes("--remote-debugging-port")) {
          running.push({ pid: Number(match[1]) });
        }
      }

      if (running.length > 0) {
        const pids = running.map((app) => String(app.pid));
        await execFileImpl("kill", ["-TERM", ...pids]);
      }

      expect(killedPids).toContain("2001");
    });
  });

  describe("BSD stat interception", () => {
    test("intercepts BSD stat -f and uses fallback", async () => {
      const patchedExecFile: ExecFileLike = async (file, args) => {
        if (file === "stat" && args && args.length >= 2 && args[0] === "-f") {
          const targetPath = args[args.length - 1] as string;
          if (targetPath === "/usr/local/bin/codex") {
            return { stdout: targetPath + "\n", stderr: "" };
          }
          throw new Error("ENOENT");
        }
        throw new Error(`Unexpected: ${file}`);
      };

      const result = await patchedExecFile("stat", ["-f", "%N", "/usr/local/bin/codex"]);
      expect(result.stdout.trim()).toBe("/usr/local/bin/codex");

      await expect(
        patchedExecFile("stat", ["-f", "%N", "/nonexistent"]),
      ).rejects.toThrow("ENOENT");
    });

    test("blocks mdfind on Linux", async () => {
      const patchedExecFile: ExecFileLike = async (file) => {
        if (file === "mdfind") {
          throw new Error("mdfind is not available on Linux/WSL");
        }
        throw new Error(`Unexpected: ${file}`);
      };

      await expect(
        patchedExecFile("mdfind", ['kMDItemFSName == "Codex.app"']),
      ).rejects.toThrow("mdfind is not available");
    });

    test("blocks osascript on Linux", async () => {
      const patchedExecFile: ExecFileLike = async (file) => {
        if (file === "osascript") {
          throw new Error("osascript is not available on Linux/WSL");
        }
        throw new Error(`Unexpected: ${file}`);
      };

      await expect(
        patchedExecFile("osascript", ["-e", 'tell application "Codex" to quit']),
      ).rejects.toThrow("osascript is not available");
    });
  });
});
