export function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseMaybeJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
