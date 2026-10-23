import { EditorState, StateEffect, type Extension } from "@codemirror/state";

/** Keep each note's history/selection while another tab or view is displayed. */
export class EditorSessions {
  private entries = new Map<string, EditorState>();
  constructor(private maxEntries = 12, private maxCharacters = 16 * 1024 * 1024) {}

  restore(key: string, content: string, extensions: Extension): EditorState {
    const previous = this.entries.get(key);
    // A disk edit must not resurrect stale content or an unrelated undo stack.
    const state = previous && previous.doc.toString() === content
      ? previous.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: content, extensions });
    this.remember(key, state);
    return state;
  }

  remember(key: string, state: EditorState) {
    this.entries.delete(key);
    this.entries.set(key, state);
    let characters = [...this.entries.values()].reduce((n, s) => n + s.doc.length, 0);
    while (this.entries.size > 1 &&
      (this.entries.size > this.maxEntries || characters > this.maxCharacters)) {
      const oldest = this.entries.keys().next().value!;
      characters -= this.entries.get(oldest)!.doc.length;
      this.entries.delete(oldest);
    }
  }

  clear() { this.entries.clear(); }
}

export const LARGE_NOTE_CHARACTERS = 1024 * 1024;
export const LARGE_NOTE_LINES = 10000;
export function isLargeNote(content: string) {
  if (content.length > LARGE_NOTE_CHARACTERS) return true;
  let lines = 1;
  for (let i = 0; i < content.length; i++)
    if (content.charCodeAt(i) === 10 && ++lines > LARGE_NOTE_LINES) return true;
  return false;
}

/** A small replacement preserves selection and undo instead of replacing the document. */
export function textChange(before: string, after: string) {
  let from = 0, endBefore = before.length, endAfter = after.length;
  while (from < endBefore && from < endAfter && before[from] === after[from]) from++;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--; endAfter--;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}
