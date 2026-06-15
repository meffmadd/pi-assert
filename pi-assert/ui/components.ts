import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Component,
  Container,
  matchesKey,
  Key,
  SelectList,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// borderBox — wrap arbitrary content in DynamicBorder / Text / Container
// pieces.  The build functions return Container ready to be returned from
// ctx.ui.custom's render.
// ---------------------------------------------------------------------------
function titledBox(theme: Theme, title: string, children: Component[]): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const c of children) container.addChild(c);
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  return container;
}

// ---------------------------------------------------------------------------
// selectDialog — generic single-select picker.
// Returns the chosen value, or `null` if the user pressed Esc.
// ---------------------------------------------------------------------------
export async function selectDialog<T>(
  ctx: ExtensionContext,
  opts: {
    title: string;
    items: SelectItem[];
    hint?: string;
    maxVisible?: number;
  },
): Promise<T | null> {
  return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
    const max = opts.maxVisible ?? Math.min(opts.items.length, 12);
    const list = new SelectList(opts.items, max, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value as T);
    list.onCancel = () => done(null);

    const container = titledBox(theme, opts.title, [
      list,
      new Text(theme.fg("dim", opts.hint ?? "↑↓ navigate • enter select • esc cancel"), 1, 0),
    ]);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// textInputDialog — single-line text input with backspace, paste support,
// and Esc to cancel.
// ---------------------------------------------------------------------------
export async function textInputDialog(
  ctx: ExtensionContext,
  opts: { title: string; label: string; hint?: string; initial?: string },
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let buffer = opts.initial ?? "";

    const inputDisplay = new (class {
      render() {
        return [`  ${theme.fg("accent", buffer || " ")}`];
      }
      invalidate() {}
    })();

    const container = titledBox(theme, opts.title, [
      new Text(theme.fg("muted", opts.label), 1, 0),
      inputDisplay,
      new Text(theme.fg("dim", opts.hint ?? "enter confirm • esc cancel"), 1, 0),
    ]);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, "enter")) {
          const trimmed = buffer.trim();
          if (!trimmed) return;
          done(trimmed);
          return;
        }
        if (matchesKey(data, "backspace")) {
          buffer = buffer.slice(0, -1);
          tui.requestRender();
          return;
        }
        // Append printable characters (supports paste)
        const filtered = data.replace(/[\x00-\x1F\x7F]/g, "");
        if (filtered.length > 0) {
          buffer += filtered;
          tui.requestRender();
        }
      },
    };
  });
}

// ---------------------------------------------------------------------------
// SectionNavigator — generic helper for moving focus across multiple
// "sections" of items with arrow keys.  Used by the AssertsPanel to let
// the user navigate across local + repo groups.
// ---------------------------------------------------------------------------
export class SectionNavigator<T> {
  focus = 0;
  selection: number[];

  constructor(public sections: { items: T[] }[]) {
    this.selection = sections.map(() => 0);
  }

  get focusedSection(): number {
    return this.focus;
  }

  get focusedIndex(): number {
    return this.selection[this.focus] ?? 0;
  }

  get focusedItem(): T | undefined {
    return this.sections[this.focus]?.items[this.focusedIndex];
  }

  /** Move focus one item within the current section. Returns true if moved. */
  moveWithin(key: "up" | "down"): boolean {
    const sec = this.sections[this.focus];
    if (!sec) return false;
    const idx = this.selection[this.focus];

    if (key === "up" && idx > 0) {
      this.selection[this.focus]--;
      return true;
    }
    if (key === "down" && idx < sec.items.length - 1) {
      this.selection[this.focus]++;
      return true;
    }
    return false;
  }

  /**
   * Cross-section arrow: at the top of a section, ↑ wraps to the bottom of
   * the previous section; at the bottom, ↓ wraps to the top of the next.
   * Returns true if the navigator moved (caller should skip delegating to
   * the inner list).
   */
  cross(key: "up" | "down"): boolean {
    const sec = this.sections[this.focus];
    if (!sec) return false;
    const idx = this.selection[this.focus];

    if (key === "up" && idx === 0 && this.focus > 0) {
      this.focus--;
      this.selection[this.focus] = this.sections[this.focus].items.length - 1;
      return true;
    }
    if (key === "down" && idx >= sec.items.length - 1 && this.focus < this.sections.length - 1) {
      this.focus++;
      this.selection[this.focus] = 0;
      return true;
    }
    return false;
  }
}
