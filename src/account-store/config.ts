import type { AuthSnapshot } from "../auth-snapshot.js";

export function validateConfigSnapshot(
  name: string,
  snapshot: AuthSnapshot,
  rawConfig: string | null,
): void {
  if (snapshot.auth_mode !== "apikey") {
    return;
  }

  if (!rawConfig) {
    throw new Error(`Current ~/.codex/config.toml is required to save apikey account "${name}".`);
  }

  if (!/^\s*model_provider\s*=\s*["'][^"']+["']/mu.test(rawConfig)) {
    throw new Error(`Current ~/.codex/config.toml is missing model_provider for apikey account "${name}".`);
  }

  if (!/^\s*base_url\s*=\s*["'][^"']+["']/mu.test(rawConfig)) {
    throw new Error(`Current ~/.codex/config.toml is missing base_url for apikey account "${name}".`);
  }
}

export function sanitizeConfigForAccountAuth(rawConfig: string): string {
  const lines = rawConfig.split(/\r?\n/u);
  const result: string[] = [];
  let skippingProviderSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      skippingProviderSection = /^\[model_providers\.[^\]]+\]$/u.test(trimmed);
      if (skippingProviderSection) {
        continue;
      }
    }

    if (skippingProviderSection) {
      continue;
    }

    if (/^\s*model_provider\s*=/u.test(line)) {
      continue;
    }

    if (/^\s*preferred_auth_method\s*=\s*["']apikey["']\s*$/u.test(line)) {
      continue;
    }

    result.push(line);
  }

  return `${result.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}
