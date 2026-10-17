import { Children, isValidElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkWikiLinks } from "../remarkWikiLinks";
import { MermaidDiagram } from "./MermaidDiagram";
import CollaborativeEditor, { type EditingSession, readDraft, downloadDraft, draftKey } from "./CollaborativeEditor";
import "katex/dist/katex.min.css";
import "./share.css";

type SharedNote = {
  editingEnabled?: boolean;
  title: string;
  content: string;
  images: Record<string, string>;
  downloads?: Record<string, { id: string; name: string; size: number }>;
  updatedAt: number;
  expiresAt: number | null;
};
const base = window.location.pathname.replace(/\/$/, "");
const external = (value: string) => /^https?:\/\//i.test(value);
const fileSize = (size: number) => size < 1024 ? `${size} B`
  : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB`
  : `${(size / 1024 / 1024).toFixed(1)} MB`;
const headingId = (children: unknown): string => {
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  if (Array.isArray(children)) return children.map(headingId).join("");
  if (children && typeof children === "object" && "props" in children)
    return headingId(
      (children as { props: { children: unknown } }).props.children,
    );
  return "";
};
function Reader() {
  const [note, setNote] = useState<SharedNote>();
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [session, setSession] = useState<EditingSession>();
  const [draft, setDraft] = useState("");
  const previousDraft = () => {
    try { return readDraft(base) || sessionStorage.getItem(draftKey(base) + ":recovery") || ""; }
    catch { return readDraft(base); }
  };
  const [recovered, setRecovered] = useState(previousDraft);
  async function join(event: React.FormEvent) {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    try {
      const response = await fetch(base + "/edit/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, name }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const retained = previousDraft();
      if (retained) {
        setRecovered(retained);
        try { sessionStorage.setItem(draftKey(base) + ":recovery", retained); } catch { /* Keep it in memory. */ }
      }
      setSession(result); setPin(""); setJoining(false);
    } catch (e: any) { setAuthError(e.message || "접속하지 못했습니다. 다시 시도해 주세요."); }
    finally { setAuthBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(base + "/data", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "공유가 중지되었거나 링크가 만료되었습니다."
              : "문서를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.",
          );
        return response.json();
      })
      .then((data: SharedNote) => {
        setNote(data);
        setError("");
        document.title = data.title + " · Lithos";
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError((previous) => previous || e.message);
      });
    void refresh();
    const interval = setInterval(refresh, 3000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);
  return (
    <div className={"reader-shell" + (session ? " is-editing" : "")}>
      <header className="reader-top">
        <span className="brand">
          <b>◈</b> Lithos
        </span>
        <span>
          공유 노트 <span aria-hidden="true">·</span> {session ? "공동 편집" : note?.editingEnabled ? "편집 참여 가능" : "읽기 전용"}
        </span>
      </header>
      {error && !session ? (
        <main className="reader-message" role="alert">
          <h1>문서를 열 수 없습니다</h1>
          <p>{error}</p>
        </main>
      ) : !note ? (
        <main className="reader-message" role="status">
          문서를 불러오는 중…
        </main>
      ) : (
        <main>
          <div className="document-heading">
            <p className="eyebrow">SHARED FROM LITHOS</p>
            <h1>{note.title}</h1>
            <p className="metadata">
              {new Date(note.updatedAt).toLocaleString("ko-KR")} 갱신
              {note.expiresAt
                ? ` · ${new Date(note.expiresAt).toLocaleDateString("ko-KR")}까지`
                : ""}
            </p>
          </div>
          {note.editingEnabled && !session && <div className="edit-entry">
            <button className="edit-primary" onClick={() => setJoining(!joining)}>암호 입력하고 편집</button>
            <span>같은 링크에서 여러 사람이 함께 작성할 수 있습니다.</span>
          </div>}
          {joining && !session && <form className="edit-auth" onSubmit={(e) => void join(e)}>
            <h2>공동 편집 참여</h2>
            <label>표시 이름<input value={name} maxLength={24} autoComplete="nickname" placeholder="참여자" onChange={(e) => setName(e.target.value)} /></label>
            <label>4자리 편집 암호<input autoFocus type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
            {authError && <p className="collab-error" role="alert">{authError}</p>}
            <button className="edit-primary" disabled={authBusy || pin.length !== 4}>{authBusy ? "접속 중…" : "편집 참여"}</button>
            <p>읽기에는 암호가 필요하지 않습니다. 잘못된 암호 5회 입력 시 1분간 잠깁니다.</p>
          </form>}
          {recovered && <div className="collab-error"><p>이 탭에 보관된 이전 편집 내용이 있습니다. 내려받아 현재 문서와 비교하세요.</p>
            <button onClick={() => downloadDraft(recovered)}>이전 편집 내용 내려받기</button>
            <button onClick={() => { setRecovered(""); try { sessionStorage.removeItem(draftKey(base) + ":recovery"); if (!session) sessionStorage.removeItem(draftKey(base)); } catch { /* Storage may be unavailable. */ } }}>보관본 정리</button>
          </div>}
          {session && <CollaborativeEditor base={base} session={session} onContent={setDraft} onExit={() => { setSession(undefined); setRecovered(previousDraft()); }} />}
          <article className="reader-content">
            <ReactMarkdown
              skipHtml
              remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks]}
              rehypePlugins={[[rehypeKatex, { trust: false }]]}
              urlTransform={(url) => url}
              components={{
                pre: ({ children }) => {
                  const code = Children.toArray(children)[0];
                  if (
                    isValidElement<{ className?: string; children?: unknown }>(code) &&
                    /(?:^|\s)language-mermaid(?:\s|$)/i.test(code.props.className || "") &&
                    typeof code.props.children === "string"
                  )
                    return <MermaidDiagram source={code.props.children.replace(/\n$/, "")} />;
                  return <pre>{children}</pre>;
                },
                a: ({ href = "", children }) => {
                  const file = Object.hasOwn(note.downloads || {}, href) ? note.downloads![href] : undefined;
                  if (file)
                    return (
                      <a className="download-link" href={`${base}/download/${file.id}`}
                        download={file.name} title={`${file.name} · ${fileSize(file.size)}`}>
                        <span>{children}</span>
                        <span className="download-meta">↓ 다운로드 · {fileSize(file.size)}</span>
                      </a>
                    );
                  if (external(href))
                    return (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {children}
                      </a>
                    );
                  if (href.startsWith("#"))
                    return <a href={href}>{children}</a>;
                  if (href.startsWith("lithos-link:")) {
                    let target = "";
                    try { target = decodeURIComponent(href.slice(12)); } catch { /* Invalid links stay inert. */ }
                    if (target.startsWith("#"))
                      return <a href={target}>{children}</a>;
                  }
                  return (
                    <span
                      className="private-link"
                      title="이 링크의 노트 또는 파일은 공유본에 포함되지 않았습니다"
                    >
                      {children}
                    </span>
                  );
                },
                img: ({ src = "", alt }) => {
                  const id = Object.hasOwn(note.images, src)
                    ? note.images[src]
                    : undefined;
                  const url = id
                    ? `${base}/asset/${id}`
                    : /^https:\/\//i.test(src)
                      ? src
                      : "";
                  return url ? (
                    <img
                      src={url}
                      alt={alt || "첨부 이미지"}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="attachment-missing">
                      첨부 이미지 미포함{alt ? ` · ${alt}` : ""}
                    </span>
                  );
                },
                h1: ({ children }) => (
                  <h1 id={headingId(children)}>{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 id={headingId(children)}>{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 id={headingId(children)}>{children}</h3>
                ),
              }}
            >
              {session ? draft : note.content}
            </ReactMarkdown>
          </article>
        </main>
      )}
      <footer>이 문서는 소유자의 Mac에서 제공됩니다.</footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Reader />);
