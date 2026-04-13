import { describe, expect, test } from "@rstest/core";

import {
  isOnlyManagedDesktopInstanceRunning,
  isRunningDesktopFromApp,
} from "../src/desktop/managed-state.js";

describe("desktop-managed-state", () => {
  test("matches the managed macOS Desktop binary path", () => {
    expect(
      isRunningDesktopFromApp(
        {
          pid: 123,
          command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223",
        },
        "/Applications/Codex.app",
        "darwin",
      ),
    ).toBe(true);
  });

  test("treats non-macOS Desktop commands via platform-aware detection", () => {
    expect(
      isRunningDesktopFromApp(
        {
          pid: 456,
          command: "/usr/local/bin/codex --remote-debugging-port=39223",
        },
        "/unused",
        "linux",
      ),
    ).toBe(true);
  });

  test("recognizes when only the managed Desktop instance is running", () => {
    expect(
      isOnlyManagedDesktopInstanceRunning(
        [
          {
            pid: 321,
            command: "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=39223",
          },
        ],
        {
          pid: 321,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 39223,
          managed_by_codexm: true,
          started_at: "2026-04-13T00:00:00.000Z",
        },
        "darwin",
      ),
    ).toBe(true);
  });
});
