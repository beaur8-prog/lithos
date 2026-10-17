import { createElement, useMemo, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { autocompletion, CompletionContext } from "@codemirror/autocomplete";
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
  drawSelection,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { api } from "../bridge";
import { remarkWikiLinks } from "../remarkWikiLinks";
import {
  resolveLink,
  titleOf,
  findHeadingOffset,
  isExternalLink,
  safeExternalUrl,
  localLinkForNavigation,
  decodeLinkPart,
  splitLink,
  toggleTaskAtOffset,
} from "../model";
import type { LinkKind } from "../model";

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly target: string,
    readonly open: (x: string) => void,
  ) {
    super();
  }
  eq(w: LinkWidget) {
    return w.text === this.text && w.target === this.target;
  }
  toDOM() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-wiki-link";
    b.textContent = this.text;
    b.onclick = () => this.open(this.target);
    return b;
  }
  ignoreEvent() {
    return true;
  }
}
function liveDecorations(open: (s: string) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) {
        this.decorations = this.build(v);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged)
          this.decorations = this.build(u.view);
      }
      build(v: EditorView) {
        const ranges: any[] = [];
        const current = v.state.doc.lineAt(v.state.selection.main.head).number;
        const inCode = (position: number) => {
          let node = syntaxTree(v.state).resolveInner(position, 1);
          for (;;) {
            if (/(?:Code|HTML)/.test(node.name)) return true;
            if (!node.parent) return false;
            node = node.parent;
          }
        };
        for (let n = 1; n <= v.state.doc.lines; n++) {
          const line = v.state.doc.line(n);
          if (inCode(line.from)) continue;
          const h = /^(#{1,6}) /.exec(line.text);
          if (h)
            ranges.push(
              Decoration.line({
                class: "cm-heading cm-heading-" + h[1].length,
              }).range(line.from),
            );
          if (n === current) continue;
          if (h)
            ranges.push(
              Decoration.replace({}).range(line.from, line.from + h[0].length),
            );
          const replaced: { from: number; to: number }[] = [];
          for (const m of line.text.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)) {
            const at = line.from + m.index!;
            if (inCode(at)) continue;
            const [target, label] = m[1].split("|");
            ranges.push(
              Decoration.replace({
                widget: new LinkWidget(label || target, target, open),
              }).range(at, at + m[0].length),
            );
            replaced.push({ from: at, to: at + m[0].length });
          }
          for (const m of line.text.matchAll(/\*\*([^*]+)\*\*/g)) {
            const at = line.from + m.index!;
            if (
              inCode(at) ||
              replaced.some((r) => at < r.to && at + m[0].length > r.from)
            )
              continue;
            ranges.push(
              Decoration.replace({}).range(at, at + 2),
              Decoration.mark({ class: "cm-live-strong" }).range(
                at + 2,
                at + m[0].length - 2,
              ),
              Decoration.replace({}).range(
                at + m[0].length - 2,
                at + m[0].length,
              ),
            );
          }
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}


function LocalImage({
  src,
  alt,
  path,
  paths,
  kind,
}: {
  src: string;
  alt?: string;
  path: string;
  paths: string[];
  kind: LinkKind;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl("");
    setFailed(false);
    if (isExternalLink(src)) {
      const external = safeExternalUrl(src);
      if (external) setUrl(external);
    } else {
      const target = resolveLink(src, path, paths, kind);
      if (target)
        api
          .assetUrl(target)
          .then((value) => {
            if (active) setUrl(value);
          })
          .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [src, path, paths, kind]);
  return url && !failed ? (
    <img src={url} alt={alt || src} onError={() => setFailed(true)} />
  ) : (
    <span className="attachment-placeholder">첨부 파일 · {alt || src}</span>
  );
}

export function MarkdownPreview({
  content,
  path,
  paths,
  onLink,
  onChange,
}: {
  content: string;
  path: string;
  paths: string[];
  onLink: (s: string) => void;
  onChange?: (s: string) => void;
}) {
  const article = useRef<HTMLElement>(null);
  const [linkError, setLinkError] = useState("");
  const fm = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  const body = fm ? content.slice(fm[0].length) : content;
  const sourceStart = fm?.[0].length || 0;
  useEffect(() => setLinkError(""), [path]);
  const heading = (
    tag: string,
    {
      children,
      node,
    }: {
      children?: ReactNode;
      node?: { position?: { start: { offset?: number } } };
    },
  ) =>
    createElement(
      tag,
      {
        "data-source-offset": sourceStart + (node?.position?.start.offset ?? 0),
      },
      children,
    );
  return (
    <article
      ref={article}
      className="markdown-preview"
      onChange={(event) => {
        const checkbox = event.target as HTMLInputElement;
        if (checkbox.type !== "checkbox" || !onChange) return;
        const item = checkbox.closest<HTMLElement>("li[data-task-offset]");
        if (!item) return;
        const offset = Number(item.dataset.taskOffset);
        onChange(toggleTaskAtOffset(content, offset, checkbox.checked));
      }}
    >
      {fm && (
        <details className="properties">
          <summary>
            속성{" "}
            <span>
              {fm[1].split("\n").filter((x) => x.includes(":")).length}
            </span>
          </summary>
          {fm[1]
            .split("\n")
            .filter((x) => x.includes(":"))
            .map((row, i) => {
              const [k, ...v] = row.split(":");
              return (
                <div className="property-row" key={i}>
                  <span>{k}</span>
                  <span>{v.join(":").trim()}</span>
                </div>
              );
            })}
        </details>
      )}
      {linkError && (
        <p role="alert" className="attachment-placeholder">
          {linkError}
        </p>
      )}
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks]}
        rehypePlugins={[[rehypeKatex, { trust: false }]]}
        urlTransform={(value) => {
          if (/^(?:lithos-link:|lithos-asset:)/.test(value)) return value;
          return isExternalLink(value)
            ? safeExternalUrl(value) || ""
            : /[\u0000-\u001f\u007f]/.test(value)
              ? ""
              : value;
        }}
        components={{
          a: ({ href, children, title }) => {
            if (!href)
              return <span title="지원하지 않는 링크 형식">{children}</span>;
            const kind: LinkKind = href.startsWith("lithos-link:")
              ? "wiki"
              : "markdown";
            const target =
              kind === "wiki" ? decodeLinkPart(href.slice(12)) : href;
            const external = isExternalLink(target);
            const externalUrl = external ? safeExternalUrl(target) : null;
            const resolved = external
              ? null
              : resolveLink(target, path, paths, kind);
            const navigation = external
              ? null
              : localLinkForNavigation(target, path, paths, kind);
            if ((external && !externalUrl) || (!external && !navigation))
              return <span title="지원하지 않는 링크 형식">{children}</span>;
            return (
              <a
                href={externalUrl || "#"}
                title={title || target}
                className={!external && !resolved ? "unresolved" : ""}
                onClick={(event) => {
                  event.preventDefault();
                  setLinkError("");
                  if (externalUrl) {
                    void api
                      .openExternal(externalUrl)
                      .catch((error) =>
                        setLinkError(
                          error?.message || "링크를 열 수 없습니다.",
                        ),
                      );
                    return;
                  }
                  const fragment = splitLink(target, kind).fragment;
                  if (resolved === path && fragment) {
                    const offset = findHeadingOffset(content, fragment);
                    const element = [
                      ...article.current!.querySelectorAll<HTMLElement>(
                        "[data-source-offset]",
                      ),
                    ].find(
                      (element) =>
                        Number(element.dataset.sourceOffset) === offset,
                    );
                    if (element) {
                      element.scrollIntoView({ behavior: "smooth" });
                      return;
                    }
                  }
                  if (navigation) onLink(navigation);
                }}
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            const kind: LinkKind = src?.startsWith("lithos-asset:")
              ? "wiki"
              : "markdown";
            const target =
              kind === "wiki"
                ? decodeLinkPart((src || "").slice(13))
                : src || "";
            return (
              <LocalImage
                key={path + "\0" + target + "\0" + kind}
                src={target}
                alt={alt}
                path={path}
                paths={paths}
                kind={kind}
              />
            );
          },
          li: ({ node, children, ...props }) => (
            <li
              {...props}
              data-task-offset={
                node?.position?.start.offset === undefined
                  ? undefined
                  : sourceStart + node.position.start.offset
              }
            >
              {children}
            </li>
          ),
          input: ({ checked, type }) => (
            <input
              type={type}
              checked={checked}
              onChange={() => {}}
              disabled={!onChange}
              aria-label={checked ? "완료된 할 일" : "미완료 할 일"}
            />
          ),
          h1: (props) => heading("h1", props),
          h2: (props) => heading("h2", props),
          h3: (props) => heading("h3", props),
          h4: (props) => heading("h4", props),
          h5: (props) => heading("h5", props),
          h6: (props) => heading("h6", props),
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}

export default function NoteEditor({
  content,
  onChange,
  path,
  paths,
  mode,
  theme,
  fontSize,
  onLink,
  jump,
}: {
  content: string;
  onChange: (s: string) => void;
  path: string;
  paths: string[];
  mode: "live" | "source" | "preview" | "split";
  theme: "dark" | "light";
  fontSize: number;
  onLink: (s: string) => void;
  jump?: { offset: number; tick: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const linkRef = useRef(onLink);
  linkRef.current = (raw) => {
    const navigation = localLinkForNavigation(raw, path, paths);
    if (navigation) onLink(navigation);
  };
  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 0 }),
      EditorView.theme({
        "&": { backgroundColor: "transparent", fontSize: fontSize + "px" },
        ".cm-content": {
          fontFamily: "inherit",
          caretColor: "var(--editor-cursor)",
          padding: "8px 0 80px",
          minHeight: "60vh",
        },
        ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.85" },
        ".cm-line": { padding: "0" },
        ".cm-gutters": { display: "none" },
        "&.cm-focused": { outline: "none" },
        ".cm-cursor, .cm-dropCursor": {
          borderLeft: "3px solid var(--editor-cursor)",
          marginLeft: "-1.5px",
        },
        ".cm-activeLine": { background: "transparent" },
        "&.cm-focused .cm-activeLine": {
          backgroundColor: "var(--editor-active-line)",
          borderRadius: "3px",
        },
      }),
      autocompletion({
        override: [
          (ctx: CompletionContext) => {
            const word = ctx.matchBefore(/\[\[[^\]]*/);
            if (!word) return null;
            return {
              from: word.from + 2,
              options: paths
                .filter((p) => p.endsWith(".md"))
                .map((p) => ({
                  label: p.replace(/\.md$/, ""),
                  displayLabel: titleOf(p),
                  type: "text",
                  apply: p.replace(/\.md$/, "") + "]]",
                })),
            };
          },
        ],
      }),
      keymap.of([
        { key: "Mod-b", run: (v) => wrap(v, "**") },
        { key: "Mod-i", run: (v) => wrap(v, "*") },
        { key: "Mod-k", run: (v) => wrap(v, "[[", "]]") },
      ]),
      ...(mode === "live" ? [liveDecorations((s) => linkRef.current(s))] : []),
    ],
    [paths.join("|"), fontSize, mode],
  );
  useEffect(() => {
    if (!jump) return;
    if (mode === "preview") {
      const element = [
        ...root.current!.querySelectorAll<HTMLElement>("[data-source-offset]"),
      ].find((element) => Number(element.dataset.sourceOffset) === jump.offset);
      element?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (editor.current) {
      const pos = Math.max(
        0,
        Math.min(jump.offset, editor.current.state.doc.length),
      );
      editor.current.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
      editor.current.focus();
    }
  }, [jump, path]);
  return (
    <div ref={root} className={"note-body mode-" + mode} style={{ fontSize }}>
      {mode !== "preview" && (
        <div className="editor-column">
          <CodeMirror
            key={path}
            value={content}
            theme={theme}
            extensions={extensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: true,
              highlightActiveLineGutter: false,
            }}
            onCreateEditor={(v) => {
              editor.current = v;
            }}
            onChange={onChange}
          />
        </div>
      )}
      {(mode === "preview" || mode === "split") && (
        <div className="preview-column">
          <MarkdownPreview
            content={content}
            path={path}
            paths={paths}
            onLink={onLink}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}
function wrap(v: EditorView, a: string, b = a) {
  const { from, to } = v.state.selection.main;
  const selected = v.state.sliceDoc(from, to);
  v.dispatch({
    changes: { from, to, insert: a + selected + b },
    selection: { anchor: from + a.length, head: to + a.length },
  });
  return true;
}
