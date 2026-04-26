export function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
