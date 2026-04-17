export interface LocalUsagePricing {
  input: number;
  output: number;
  cached_input?: number;
}

export const LOCAL_USAGE_PRICING_VERSION = 1;

export const LOCAL_USAGE_PRICING_BY_MODEL: Record<string, LocalUsagePricing> = {
  "gpt-5": { input: 1.25e-6, output: 1e-5, cached_input: 1.25e-7 },
  "gpt-5-codex": { input: 1.25e-6, output: 1e-5, cached_input: 1.25e-7 },
  "gpt-5-mini": { input: 2.5e-7, output: 2e-6, cached_input: 2.5e-8 },
  "gpt-5-nano": { input: 5e-8, output: 4e-7, cached_input: 5e-9 },
  "gpt-5.1": { input: 1.25e-6, output: 1e-5, cached_input: 1.25e-7 },
  "gpt-5.1-codex": { input: 1.25e-6, output: 1e-5, cached_input: 1.25e-7 },
  "gpt-5.1-codex-max": { input: 1.25e-6, output: 1e-5, cached_input: 1.25e-7 },
  "gpt-5.1-codex-mini": { input: 2.5e-7, output: 2e-6, cached_input: 2.5e-8 },
  "gpt-5.2": { input: 1.75e-6, output: 1.4e-5, cached_input: 1.75e-7 },
  "gpt-5.2-codex": { input: 1.75e-6, output: 1.4e-5, cached_input: 1.75e-7 },
  "gpt-5.3-codex": { input: 1.75e-6, output: 1.4e-5, cached_input: 1.75e-7 },
  "gpt-5.4": { input: 2.5e-6, output: 1.5e-5, cached_input: 2.5e-7 },
  "gpt-5.4-mini": { input: 7.5e-7, output: 4.5e-6, cached_input: 7.5e-8 },
  "gpt-5.4-nano": { input: 2e-7, output: 1.25e-6, cached_input: 2e-8 },
  qwen35_4b: { input: 0, output: 0, cached_input: 0 },
};
