import { describe, expect, test } from "@rstest/core";
import {
  getPlatform,
  resetPlatformCache,
  setPlatformForTesting,
  getCodexBinarySuffix,
  isCodexDesktopCommand,
  isCodexCliCommand,
} from "../src/platform.js";

describe("getPlatform", () => {
  test("returns a valid platform string", async () => {
    resetPlatformCache();
    const platform = await getPlatform();
    expect(["darwin", "linux", "wsl"]).toContain(platform);
  });

  test("caches the result across calls", async () => {
    resetPlatformCache();
    const first = await getPlatform();
    const second = await getPlatform();
    expect(first).toBe(second);
  });
});

describe("setPlatformForTesting", () => {
  test("overrides the cached platform", async () => {
    const cleanup = setPlatformForTesting("wsl");
    try {
      const platform = await getPlatform();
      expect(platform).toBe("wsl");
    } finally {
      cleanup();
    }
  });

  test("cleanup restores previous value", async () => {
    resetPlatformCache();
    const original = await getPlatform();

    const cleanup = setPlatformForTesting("wsl");
    expect(await getPlatform()).toBe("wsl");

    cleanup();
    expect(await getPlatform()).toBe(original);
  });
});

describe("getCodexBinarySuffix", () => {
  test("returns macOS binary suffix for darwin", () => {
    expect(getCodexBinarySuffix("darwin")).toBe("/Contents/MacOS/Codex");
  });

  test("returns linux binary name for linux", () => {
    expect(getCodexBinarySuffix("linux")).toBe("codex");
  });

  test("returns linux binary name for wsl", () => {
    expect(getCodexBinarySuffix("wsl")).toBe("codex");
  });
});

describe("isCodexDesktopCommand", () => {
  test("matches macOS Desktop command on darwin", () => {
    expect(
      isCodexDesktopCommand(
        "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9223",
        "darwin",
      ),
    ).toBe(true);
  });

  test("does not match plain codex on darwin", () => {
    expect(isCodexDesktopCommand("/usr/local/bin/codex", "darwin")).toBe(false);
  });

  test("matches codex binary on linux", () => {
    expect(
      isCodexDesktopCommand("/usr/bin/codex --some-flag", "linux"),
    ).toBe(true);
  });

  test("matches codex binary on wsl", () => {
    expect(
      isCodexDesktopCommand("/usr/local/bin/codex --remote-debugging-port=9223", "wsl"),
    ).toBe(true);
  });
});

describe("isCodexCliCommand", () => {
  test("matches plain codex command", () => {
    expect(isCodexCliCommand("/usr/bin/codex")).toBe(true);
  });

  test("matches codex with arguments", () => {
    expect(isCodexCliCommand("/usr/local/bin/codex --model o4-mini")).toBe(true);
  });

  test("does not match codex with remote-debugging-port (Desktop)", () => {
    expect(
      isCodexCliCommand("/usr/bin/codex --remote-debugging-port=9223"),
    ).toBe(false);
  });

  test("does not match non-codex binary", () => {
    expect(isCodexCliCommand("/usr/bin/node server.js")).toBe(false);
  });
});
