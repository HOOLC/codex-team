export const PROXY_ACCOUNT_NAME = "proxy";
export const PROXY_EMAIL = "proxy@codexm.local";
export const PROXY_ACCOUNT_ID = "codexm-proxy-account";
export const PROXY_USER_ID = "codexm-proxy";
export const PROXY_PLAN_TYPE = "pro";
export const PROXY_IDENTITY = `${PROXY_ACCOUNT_ID}:${PROXY_USER_ID}`;
export const PROXY_MODEL_PROVIDER_ID = "codexm_proxy";
export const PROXY_MODEL_PROVIDER_NAME = "codexm_proxy";
export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 14555;
export const PROXY_PORT_ENV_VAR = "CODEXM_PROXY_PORT";
export const CHATGPT_UPSTREAM_BASE_URL = "https://chatgpt.com";
export const OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com/v1";

function parseProxyPort(raw: string, sourceLabel: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${sourceLabel} must be an integer from 1 to 65535.`);
  }
  return parsed;
}

export function resolveProxyPort(options: {
  cliValue?: string | null;
  env?: NodeJS.ProcessEnv;
  fallback?: number | null;
} = {}): number {
  if (options.cliValue && options.cliValue.trim() !== "") {
    return parseProxyPort(options.cliValue, "--port");
  }

  const envValue = (options.env ?? process.env)[PROXY_PORT_ENV_VAR];
  if (typeof envValue === "string" && envValue.trim() !== "") {
    return parseProxyPort(envValue, PROXY_PORT_ENV_VAR);
  }

  if (
    typeof options.fallback === "number"
    && Number.isInteger(options.fallback)
    && options.fallback > 0
    && options.fallback <= 65_535
  ) {
    return options.fallback;
  }

  return DEFAULT_PROXY_PORT;
}

export function proxyBackendBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}/backend-api`;
}

export function proxyOpenAIBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}/v1`;
}
