/** Shared entry types and identity/reference helpers. */

export type Hook = "tool_call" | "tool_result" | "agent_end";
export type FilterScalar = string | number | boolean | null;
export type EntryFilter = Record<string, FilterScalar | FilterScalar[]>;

export interface PersistedAssert {
  description: string;
  hook: Hook;
  filter?: EntryFilter;
  when?: string;
  shell: string;
  default?: boolean;
}

export interface PersistedPreset {
  description: string;
  preset: string[];
  default?: boolean;
}

export type PersistedEntry = PersistedAssert | PersistedPreset;

/** Canonical identity. Names are unique only within a source. */
export function entryKey(source: string, name: string): string {
  return `${source}\x00${name}`;
}

/** Qualified preset reference. */
export function entryRef(source: string, name: string): string {
  return `${source}/${name}`;
}

/** Split a qualified ref on its last slash. */
export function parseEntryRef(ref: string): { source: string; name: string } | null {
  const index = ref.lastIndexOf("/");
  if (index <= 0 || index === ref.length - 1) return null;
  return { source: ref.slice(0, index), name: ref.slice(index + 1) };
}

/** Reusable lookup index for runtime or persisted entries. */
export class AssertIndex<T extends { source: string; name: string }> {
  readonly byKey = new Map<string, T>();
  readonly byRef = new Map<string, T>();
  readonly nameCounts = new Map<string, number>();

  constructor(entries: Iterable<T>) {
    for (const entry of entries) {
      this.byKey.set(entryKey(entry.source, entry.name), entry);
      this.byRef.set(entryRef(entry.source, entry.name), entry);
      this.nameCounts.set(entry.name, (this.nameCounts.get(entry.name) ?? 0) + 1);
    }
  }

  get(source: string, name: string): T | undefined {
    return this.byKey.get(entryKey(source, name));
  }

  getRef(ref: string): T | undefined {
    return this.byRef.get(ref);
  }

  /** Resolve a legacy bare name only when it is unambiguous. */
  resolveLegacyName(name: string): T | undefined {
    if (this.nameCounts.get(name) !== 1) return undefined;
    for (const entry of this.byKey.values()) {
      if (entry.name === name) return entry;
    }
    return undefined;
  }
}
