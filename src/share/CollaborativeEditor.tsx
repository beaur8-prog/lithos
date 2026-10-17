import { useEffect, useRef, useState } from "react";
import { EditorState, ChangeSet, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { collab, sendableUpdates, receiveUpdates, getSyncedVersion } from "@codemirror/collab";

export type EditingSession = { session: string; clientID: string; content: string; epoch: string; version: number };
export const draftKey = (base: string) => `lithos-draft:${base}`;
export function readDraft(base: string) {
  try { return sessionStorage.getItem(draftKey(base)) || ""; } catch { return ""; }
}
export function downloadDraft(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = "Lithos-편집-보관본.md"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function CollaborativeEditor({ base, session, onExit, onContent }: {
  base: string; session: EditingSession; onExit: () => void; onContent: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onExit, onContent });
  callbacks.current = { onExit, onContent };
  const [status, setStatus] = useState("연결 중…");
  const [participants, setParticipants] = useState<{ id: string; name: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [fatal, setFatal] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let stopped = false, busy = false, failed = false;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;
    const writable = new Compartment();
    const preserve = (view: EditorView) => {
      const waiting = sendableUpdates(view.state).length > 0;
      setPending(waiting);
      try {
        if (waiting || failed) sessionStorage.setItem(draftKey(base), view.state.doc.toString());
        else sessionStorage.removeItem(draftKey(base));
      } catch { /* beforeunload and the explicit draft download remain available */ }
      return waiting;
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: session.content, extensions: [
        markdown(), syntaxHighlighting(defaultHighlightStyle), history(),
        keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
        drawSelection({ cursorBlinkRate: 0 }), highlightActiveLine(),
        collab({ startVersion: session.version, clientID: session.clientID }),
        writable.of(EditorState.readOnly.of(false)),
        EditorView.contentAttributes.of({ "aria-label": "공동 편집 본문", spellcheck: "true" }),
        EditorView.updateListener.of((update) => {
          const waiting = preserve(update.view);
          if (update.docChanged) callbacks.current.onContent(update.state.doc.toString());
          if (waiting && !failed) {
            setStatus("저장 중…");
            if (!busy) { clearTimeout(timer); timer = setTimeout(sync, 180); }
          }
        }),
      ] }),
    });
    viewRef.current = view;
    callbacks.current.onContent(session.content);
    async function sync() {
      if (stopped || busy || failed) return;
      if (view.composing) { timer = setTimeout(sync, 400); return; }
      busy = true;
      const updates = sendableUpdates(view.state).slice(0, 100);
      const version = getSyncedVersion(view.state);
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 12000);
      try {
        const response = await fetch(base + "/edit/updates" + (updates.length ? "" : `?version=${version}&epoch=${session.epoch}`), {
          method: updates.length ? "POST" : "GET", cache: "no-store", signal: request.signal,
          headers: { Authorization: `Bearer ${session.session}`, ...(updates.length ? { "Content-Type": "application/json" } : {}) },
          ...(updates.length ? { body: JSON.stringify({ epoch: session.epoch, version,
            updates: updates.map((u) => ({ changes: u.changes.toJSON() })) }) } : {}),
        });
        const data = await response.json();
        if (stopped) return;
        if (!response.ok) {
          if ([400, 401, 403, 404, 409, 413].includes(response.status)) {
            failed = true;
            preserve(view);
            setFatal(data.error || "편집을 이어갈 수 없습니다. 입력 내용을 보관해 주세요.");
            view.dispatch({ effects: writable.reconfigure(EditorState.readOnly.of(true)) });
            return;
          }
          throw new Error(data.error);
        }
        if (data.updates.length) view.dispatch(receiveUpdates(view.state, data.updates.map((u: { changes: unknown; clientID: string }) => ({ ...u, changes: ChangeSet.fromJSON(u.changes) }))));
        setParticipants(data.participants);
        setStatus(preserve(view) ? "저장 중…" : "모든 변경 내용 저장됨");
      } catch {
        if (!stopped) { preserve(view); setStatus("연결 재시도 중 · 입력 내용은 이 탭에 보관됩니다"); }
      } finally {
        clearTimeout(timeout);
        busy = false;
        if (!stopped && !failed) timer = setTimeout(sync, sendableUpdates(view.state).length ? 400 : 1000);
      }
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (sendableUpdates(view.state).length) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", beforeUnload);
    timer = setTimeout(sync, 0);
    view.focus();
    return () => {
      stopped = true; clearTimeout(timer); request?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
      view.destroy(); viewRef.current = null;
    };
  }, [base, session]);
  return <section className="collab-workspace" aria-label="공동 편집">
    <div className="collab-toolbar">
      <div><strong>함께 편집 중</strong><span role="status">{fatal ? "편집이 일시 중지되었습니다" : status}</span></div>
      <button disabled={pending && !fatal} onClick={() => {
        void fetch(base + "/edit/leave", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.session}` }, body: "{}" });
        callbacks.current.onExit();
      }}>읽기로 돌아가기</button>
    </div>
    <div className="collab-people">{participants.length || 1}명 참여 · {participants.map((p) => p.name).join(" · ") || "접속 중"}</div>
    <p className="collab-hint">마크다운으로 작성하면 이 Mac의 원본 노트에 자동 저장됩니다. 새 로컬 파일은 소유자가 첨부하고 공유해야 합니다.</p>
    {fatal && <div className="collab-error" role="alert"><p>{fatal}</p><p>현재 내용을 보관한 뒤 읽기로 돌아가 다시 참여하세요.</p></div>}
    <div className="collab-editor" ref={host} />
    <div className="collab-bottom"><button onClick={() => downloadDraft(viewRef.current?.state.doc.toString() || session.content)}>현재 내용 내려받기</button>
      <label><input type="checkbox" checked={preview} onChange={(e) => { setPreview(e.target.checked); document.querySelector(".reader-shell")?.classList.toggle("show-edit-preview", e.target.checked); }} /> 미리보기 표시</label>
    </div>
  </section>;
}
