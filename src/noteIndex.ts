import { extractLinks, headings, tags } from "./model";
import { isLargeNote } from "./editorSessions";

export class NoteIndex {
  private entries = new Map<string, ReturnType<typeof analyze>>();
  get(path: string, content: string) {
    const previous = this.entries.get(path);
    if (previous?.content === content) return previous;
    const next = analyze(content);
    this.entries.set(path, next);
    return next;
  }
  retain(paths: string[]) {
    const current = new Set(paths);
    for (const path of this.entries.keys()) if (!current.has(path)) this.entries.delete(path);
  }
}

function analyze(content: string) {
  const large = isLargeNote(content);
  return { content, large,
    links: large ? [] : extractLinks(content),
    headings: large ? [] : headings(content),
    tags: large ? [] : tags(content),
    wordCount: large ? null : (content.trim() ? content.trim().split(/\s+/).length : 0),
  };
}
