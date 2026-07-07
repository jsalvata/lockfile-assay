import { parse } from 'yaml';

export type Delta = { pkg: string; committed: string | null; derived: string | null };

function versions(lock: Buffer | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (lock === null) return map;
  let doc: unknown;
  try {
    doc = parse(lock.toString('utf8'));
  } catch {
    return map; // a lockfile pnpm's own serializer wrote always parses; report-side only, degrade quietly
  }
  const packages = (doc as { packages?: Record<string, unknown> })?.packages ?? {};
  for (const key of Object.keys(packages)) {
    const bare = key.replace(/\(.*$/, ''); // strip peer suffix
    const at = bare.lastIndexOf('@');
    if (at <= 0) continue;
    const name = bare.slice(0, at);
    const version = bare.slice(at + 1);
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)?.add(version);
  }
  return map;
}

export function deltaSummary(committed: Buffer | null, derived: Buffer): Delta[] {
  const c = versions(committed);
  const d = versions(derived);
  const names = [...new Set([...c.keys(), ...d.keys()])].sort();
  const out: Delta[] = [];
  for (const name of names) {
    const cv = [...(c.get(name) ?? [])].sort().join(', ') || null;
    const dv = [...(d.get(name) ?? [])].sort().join(', ') || null;
    if (cv !== dv) out.push({ pkg: name, committed: cv, derived: dv });
  }
  return out;
}
