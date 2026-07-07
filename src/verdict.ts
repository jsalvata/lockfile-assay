export function bytesEqual(a: Buffer | null, b: Buffer): boolean {
  if (a === null) return false;
  return a.equals(b);
}
