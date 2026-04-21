import type { DaemonProcessState } from "./process.js";

export function describeDaemonFeatureLine(status: {
  running: boolean;
  state: DaemonProcessState | null;
}): string {
  return [
    `Daemon: ${status.running ? "on" : "off"}`,
    `Proxy: ${status.running && status.state?.proxy ? "on" : "off"}`,
    `Autoswitch: ${status.running && status.state?.auto_switch ? "on" : "off"}`,
  ].join(" | ");
}

export function appendDaemonFeatureTags(
  currentStatusLine: string,
  status: {
    running: boolean;
    state: DaemonProcessState | null;
  },
): string {
  return `${currentStatusLine} | [daemon:${status.running ? "on" : "off"}] [proxy:${status.running && status.state?.proxy ? "on" : "off"}] [autoswitch:${status.running && status.state?.auto_switch ? "on" : "off"}]`;
}
