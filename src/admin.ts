export function parseAdminIds(value?: string): Set<number> {
  if (!value) {
    return new Set<number>();
  }

  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry));

  return new Set<number>(ids);
}

export function isAdminUser(
  userId: number,
  adminIds: Set<number> = new Set(),
): boolean {
  return adminIds.has(userId);
}
