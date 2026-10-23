import { useLayoutEffect, useMemo, useRef } from "react";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getDefaultExtensions } from "@uiw/react-codemirror";
import { EditorSessions } from "../editorSessions";

export default function PersistentEditor({ sessionKey, sessions, value, theme, extensions,
  readOnly = false, onChange, onCreateEditor }: {
  sessionKey: string;
  sessions: EditorSessions;
  value: string;
  theme: "dark" | "light";
  extensions: Extension[];
  readOnly?: boolean;
  onChange: (content: string) => void;
  onCreateEditor: (view: EditorView | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const created = useRef(onCreateEditor);
  created.current = onCreateEditor;
  const configuration = useMemo(() => [
    ...getDefaultExtensions({ theme, readOnly, editable: !readOnly,
      basicSetup: { lineNumbers: false, foldGutter: false,
        highlightActiveLine: true, highlightActiveLineGutter: false } }),
    ...extensions,
    EditorView.contentAttributes.of({ "aria-label": readOnly ? "노트 원문 읽기" : "노트 본문" }),
    EditorView.updateListener.of((update) => {
      sessions.remember(sessionKey, update.state);
      if (update.docChanged) change.current(update.state.doc.toString());
    }),
  ], [theme, readOnly, extensions, sessionKey, sessions]);
  const config = useRef(configuration);
  config.current = configuration;

  useLayoutEffect(() => {
    const editor = new EditorView({ parent: container.current!,
      state: sessions.restore(sessionKey, value, config.current) });
    view.current = editor;
    created.current(editor);
    return () => {
      sessions.remember(sessionKey, editor.state);
      editor.destroy();
      view.current = null;
      created.current(null);
    };
  }, [sessionKey, sessions]);

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: StateEffect.reconfigure.of(configuration) });
  }, [configuration]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      // External file changes replace the state without generating a local save
      // or allowing undo to overwrite another program's new content.
      editor.setState(EditorState.create({ doc: value, extensions: config.current }));
      sessions.remember(sessionKey, editor.state);
    }
  }, [value, sessionKey, sessions]);

  return <div className="cm-theme" ref={container} />;
}
