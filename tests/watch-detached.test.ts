import { describe, expect, test } from "@rstest/core";

import { ensureDetachedWatch } from "../src/watch/detached.js";

describe("watch-detached", () => {
  test("reuses an existing detached watch when options match", async () => {
    const result = await ensureDetachedWatch(
      {
        async getStatus() {
          return {
            running: true,
            state: {
              pid: 11,
              started_at: "2026-04-13T00:00:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              auto_switch_eta_hours: null,
              debug: false,
            },
          };
        },
        async startDetached() {
          throw new Error("should not restart");
        },
        async stop() {
          throw new Error("should not stop");
        },
      },
      { autoSwitch: true, autoSwitchEtaHours: null, debug: false },
    );

    expect(result).toEqual({
      action: "reused",
      state: {
        pid: 11,
        started_at: "2026-04-13T00:00:00.000Z",
        log_path: "/tmp/watch.log",
        auto_switch: true,
        auto_switch_eta_hours: null,
        debug: false,
      },
    });
  });

  test("restarts an existing detached watch when options differ", async () => {
    const calls: string[] = [];

    const result = await ensureDetachedWatch(
      {
        async getStatus() {
          return {
            running: true,
            state: {
              pid: 11,
              started_at: "2026-04-13T00:00:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: false,
              auto_switch_eta_hours: null,
              debug: false,
            },
          };
        },
        async startDetached() {
          calls.push("start");
          return {
            pid: 22,
            started_at: "2026-04-13T00:01:00.000Z",
            log_path: "/tmp/watch.log",
            auto_switch: true,
            auto_switch_eta_hours: null,
            debug: false,
          };
        },
        async stop() {
          calls.push("stop");
          return {
            running: false,
            state: null,
            stopped: true,
          };
        },
      },
      { autoSwitch: true, autoSwitchEtaHours: null, debug: false },
    );

    expect(calls).toEqual(["stop", "start"]);
    expect(result).toEqual({
      action: "restarted",
      state: {
        pid: 22,
        started_at: "2026-04-13T00:01:00.000Z",
        log_path: "/tmp/watch.log",
        auto_switch: true,
        auto_switch_eta_hours: null,
        debug: false,
      },
    });
  });

  test("restarts an existing detached watch when ETA threshold differs", async () => {
    const calls: string[] = [];

    const result = await ensureDetachedWatch(
      {
        async getStatus() {
          return {
            running: true,
            state: {
              pid: 11,
              started_at: "2026-04-13T00:00:00.000Z",
              log_path: "/tmp/watch.log",
              auto_switch: true,
              auto_switch_eta_hours: 0.5,
              debug: false,
            },
          };
        },
        async startDetached() {
          calls.push("start");
          return {
            pid: 22,
            started_at: "2026-04-13T00:01:00.000Z",
            log_path: "/tmp/watch.log",
            auto_switch: true,
            auto_switch_eta_hours: 0.25,
            debug: false,
          };
        },
        async stop() {
          calls.push("stop");
          return {
            running: false,
            state: null,
            stopped: true,
          };
        },
      },
      { autoSwitch: true, autoSwitchEtaHours: 0.25, debug: false },
    );

    expect(calls).toEqual(["stop", "start"]);
    expect(result).toEqual({
      action: "restarted",
      state: {
        pid: 22,
        started_at: "2026-04-13T00:01:00.000Z",
        log_path: "/tmp/watch.log",
        auto_switch: true,
        auto_switch_eta_hours: 0.25,
        debug: false,
      },
    });
  });
});
