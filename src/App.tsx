import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Files,
  Search,
  Bookmark,
  Network,
  LayoutDashboard,
  CalendarDays,
  Command,
  Settings,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  FilePlus2,
  X,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Code2,
  Columns2,
  PenLine,
  MoreHorizontal,
  Link2,
  List,
  Hash,
  Check,
  CheckCheck,
  Trash2,
  FolderOpen,
  Sun,
  Moon,
  Paperclip,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Braces,
  Grip,
  Import,
  Home,
  Share2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "./bridge";
import type { VaultState, Workspace, VaultFile } from "./types";
import {
  basename,
  titleOf,
  isNote,
  resolveLink,
  extractLinks,
  normalize,
  splitLink,
  isExternalLink,
  safeExternalUrl,
  localLinkForNavigation,
  findHeadingOffset,
} from "./model";
import NoteEditor from "./components/NoteEditor";
import CanvasView from "./components/CanvasView";
import GraphView from "./components/GraphView";
import ShareDialog from "./components/ShareDialog";
import { attachmentMarkdown } from "./attachmentLinks";
import { EditorSessions } from "./editorSessions";
import { NoteIndex } from "./noteIndex";

type Modal = {
  kind:
    | "create"
    | "folder"
    | "canvas"
    | "rename"
    | "quick"
    | "commands"
    | "settings"
    | "vault"
    | "trash"
    | "delete";
  path?: string;
};
const IconButton = ({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) => (
  <button
    type="button"
    className={"icon-button" + (active ? " active" : "")}
    title={label}
    aria-label={label}
    onClick={onClick}
    disabled={disabled}
  >
    <Icon size={17} strokeWidth={1.65} />
  </button>
);
const noteTypes = /\.(md|canvas)$/i;
export default function App() {
  const [vault, setVault] = useState<VaultState | null>(null),
    [docs, setDocs] = useState<Record<string, string>>({}),
    [tabs, setTabs] = useState<string[]>([]),
    [active, setActive] = useState(""),
    [mode, setMode] = useState<NonNullable<Workspace["mode"]>>("live"),
    [theme, setTheme] = useState<"dark" | "light">("dark"),
    [fontSize, setFontSize] = useState(16),
    [bookmarks, setBookmarks] = useState<string[]>([]);
  const [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    [section, setSection] = useState<"files" | "search" | "bookmarks">("files"),
    [rightTab, setRightTab] = useState<"links" | "outline" | "tags">("links"),
    [query, setQuery] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [sort, setSort] = useState<"name" | "modified">("name");
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null),
    [input, setInput] = useState(""),
    [modalIndex, setModalIndex] = useState(0),
    [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(
      null,
    ),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [jump, setJump] = useState<{ offset: number; tick: number }>(),
    [splitPath, setSplitPath] = useState<string | null>(null),
    [trashItems, setTrashItems] = useState<any[]>([]),
    [ready, setReady] = useState(false),
    [unreadable, setUnreadable] = useState<Set<string>>(new Set());
  const revisions = useRef(new Map<string, number>());
  const editorSessions = useRef(new EditorSessions());
  const splitSessions = useRef(new EditorSessions());
  const noteIndex = useRef(new NoteIndex());
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const dirty = useRef(new Map<string, string>()),
    timers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
    queues = useRef(new Map<string, Promise<unknown>>());
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const history = useRef<string[]>([]),
    historyIndex = useRef(-1);
  const rootToken = useRef(0),
    loadGeneration = useRef(0),
    [historyTick, setHistoryTick] = useState(0);
  const notify = (message: string) => {
    setToast(message);
  };
  const fail = (e: any) => {
    setError(e?.message || String(e));
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const paths = useMemo(
    () =>
      vault?.files.filter((x) => x.type === "file").map((x) => x.path) || [],
    [vault],
  );
  const notes = useMemo(
    () =>
      paths.filter(isNote).map((path) => ({
        path,
        title: titleOf(path),
        content: docs[path] || "",
        metadata: noteIndex.current.get(path, docs[path] || ""),
      })),
    [paths, docs],
  );
  const save = useCallback((path: string) => {
    const value = dirty.current.get(path);
    if (value === undefined)
      return queues.current.get(path) || Promise.resolve();
    const root = rootToken.current;
    setSaving(true);
    const chain = (queues.current.get(path) || Promise.resolve())
      .catch(() => {})
      .then(() => api.writeFile(path, value))
      .then(() => {
        if (root === rootToken.current && dirty.current.get(path) === value)
          dirty.current.delete(path);
      })
      .catch((e) => {
        fail(e);
        throw e;
      })
      .finally(() => {
        if (root === rootToken.current) setSaving(dirty.current.size > 0);
      });
    queues.current.set(path, chain);
    return chain;
  }, []);
  const flush = useCallback(async () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    await Promise.all([...dirty.current.keys()].map((p) => save(p)));
    await Promise.all([...queues.current.values()]);
    if (dirty.current.size)
      throw Error("저장하지 못한 변경 내용이 있습니다. 다시 시도해 주세요.");
  }, [save]);
  function edit(path: string, value: string) {
    if (vault?.editingPaths?.includes(path)) return;
    revisions.current.set(path, (revisions.current.get(path) || 0) + 1);
    setDocs((prev) => ({ ...prev, [path]: value }));
    docsRef.current[path] = value;
    dirty.current.set(path, value);
    setSaving(true);
    clearTimeout(timers.current.get(path));
    timers.current.set(
      path,
      setTimeout(() => {
        void save(path).catch(() => {});
      }, 300),
    );
  }
  const refresh = useCallback(async (state?: VaultState, reconcile = false) => {
    const gen = ++loadGeneration.current,
      token = rootToken.current,
      readVersions = new Map(revisions.current);
    const s = state || (await api.getState());
    const out: Record<string, string> = {},
      failed = new Set<string>();
    const files = s.files.filter(
      (f) => f.type === "file" && noteTypes.test(f.path),
    );
    for (let i = 0; i < files.length; i += 12) {
      await Promise.all(
        files.slice(i, i + 12).map(async (f) => {
          try {
            out[f.path] = await api.readFile(f.path);
          } catch (e) {
            failed.add(f.path);
            fail(e);
          }
        }),
      );
    }
    if (gen !== loadGeneration.current || token !== rootToken.current) return;
    setVault(s);
    setUnreadable(failed);
    if (reconcile) {
      const exists = (p: string) =>
        p === "@graph" ||
        s.files.some((f) => f.type === "file" && f.path === p);
      setTabs((prev) => prev.filter(exists));
      setActive((prev) => (exists(prev) ? prev : ""));
      setSplitPath((prev) => (prev && exists(prev) ? prev : null));
    }
    setDocs((prev) => {
      for (const p of failed) {
        if (p in prev) out[p] = prev[p];
      }
      for (const [p, version] of revisions.current) {
        if (version !== (readVersions.get(p) || 0) && p in prev)
          out[p] = prev[p];
      }
      for (const [p, c] of dirty.current) out[p] = c;
      return out;
    });
  }, []);
  async function initialize(s?: VaultState) {
    setReady(false);
    editorSessions.current = new EditorSessions();
    splitSessions.current = new EditorSessions();
    noteIndex.current = new NoteIndex();
    setDocs({});
    setUnreadable(new Set());
    rootToken.current++;
    dirty.current.clear();
    queues.current.clear();
    setSplitPath(null);
    await refresh(s);
    const raw = await api.getWorkspace();
    const ws: Workspace = raw && typeof raw === "object" ? raw : {};
    ws.tabs = Array.isArray(ws.tabs)
      ? ws.tabs.filter((x) => typeof x === "string")
      : [];
    ws.bookmarks = Array.isArray(ws.bookmarks)
      ? ws.bookmarks.filter((x) => typeof x === "string")
      : [];
    const st = s || (await api.getState());
    const available = st.files
      .filter((f) => f.type === "file" && noteTypes.test(f.path))
      .map((f) => f.path);
    const restored = ws.tabs?.filter(
      (p) => p === "@graph" || available.includes(p),
    );
    const first =
      available.find((p) => p === "시작하기.md") || available[0] || "";
    setTabs(restored?.length ? restored : first ? [first] : []);
    setActive(
      ws.active && (ws.active === "@graph" || available.includes(ws.active))
        ? ws.active
        : first,
    );
    setBookmarks(ws.bookmarks || []);
    setTheme(ws.theme || "dark");
    setMode(
      ["live", "source", "preview", "split"].includes(ws.mode || "")
        ? ws.mode!
        : "live",
    );
    setFontSize(
      typeof ws.fontSize === "number"
        ? Math.max(13, Math.min(24, ws.fontSize))
        : 16,
    );
    setRight(ws.rightPanel !== false);
    history.current = [ws.active || first];
    historyIndex.current = 0;
    setReady(true);
  }
  useEffect(() => {
    void initialize().catch(fail);
    const unsub = api.onChanged((e) => {
      void refresh(undefined, e?.type === "external").catch(fail);
    });
    return unsub;
  }, []);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      void api
        .saveWorkspace({
          tabs,
          active,
          bookmarks,
          theme,
          mode,
          fontSize,
          rightPanel: right,
        })
        .catch(fail);
    }, 250);
    return () => clearTimeout(t);
  }, [tabs, active, bookmarks, theme, mode, fontSize, right, ready]);
  useEffect(() => {
    const native = api as any;
    return native.onBeforeClose?.(() => {
      void flush()
        .then(() => native.confirmClose())
        .catch((e) => {
          native.cancelClose?.();
          fail(e);
        });
    });
  }, [flush]);
  function open(path: string, record = true) {
    setActive(path);
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    if (record && history.current[historyIndex.current] !== path) {
      history.current = history.current
        .slice(0, historyIndex.current + 1)
        .concat(path);
      historyIndex.current = history.current.length - 1;
      setHistoryTick((x) => x + 1);
    }
  }
  function go(delta: number) {
    const next = historyIndex.current + delta;
    if (next >= 0 && next < history.current.length) {
      historyIndex.current = next;
      open(history.current[next], false);
      setHistoryTick((x) => x + 1);
    }
  }
  async function closeTab(path: string) {
    try {
      await flush();
      setTabs((prev) => {
        const next = prev.filter((p) => p !== path);
        if (active === path)
          setActive(next[Math.max(0, prev.indexOf(path) - 1)] || "");
        return next;
      });
    } catch (e) {
      fail(e);
    }
  }
  function show(kind: Modal["kind"], path?: string) {
    setInput(kind === "rename" ? path || "" : "");
    setModalIndex(0);
    setModal({ kind, path });
    setMenu(null);
    if (kind === "trash" && api.getTrash)
      api.getTrash().then(setTrashItems).catch(fail);
  }
  async function openLink(raw: string, from = active) {
    if (isExternalLink(raw)) {
      const url = safeExternalUrl(raw);
      if (url) void api.openExternal(url).catch(fail);
      return;
    }
    const navigation = localLinkForNavigation(raw, from, paths);
    if (!navigation) return;
    const target = resolveLink(navigation, from, paths),
      parts = splitLink(navigation);
    if (target) {
      open(target);
      if (parts.fragment) {
        const offset = findHeadingOffset(
          docsRef.current[target] || "",
          parts.fragment,
        );
        if (offset !== undefined)
          setTimeout(() => setJump({ offset, tick: Date.now() }), 50);
      }
      return;
    }
    const name = parts.target;
    if (!name) return;
    const canvas = name.endsWith(".canvas");
    if (/\.[^/]+$/.test(name) && !canvas && !name.endsWith(".md")) {
      notify("연결된 파일을 보관함에서 찾을 수 없습니다.");
      return;
    }
    const p = normalize(name + (canvas || name.endsWith(".md") ? "" : ".md"));
    try {
      await flush();
      const s = await api.createFile(
        p,
        canvas ? '{"nodes":[],"edges":[]}' : "# " + titleOf(p) + "\n\n",
      );
      await refresh(s);
      open(p);
      if (!canvas) setMode("live");
      notify("연결된 새 노트를 만들었습니다.");
    } catch (e) {
      fail(e);
    }
  }
  async function daily() {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const path = "일일 노트/" + date + ".md";
    if (paths.includes(path)) {
      open(path);
      return;
    }
    try {
      await flush();
      const s = await api.createFile(
        path,
        `# ${date}\n\n## 오늘의 기록\n\n\n## 할 일\n\n- [ ] \n\n## 떠오른 생각\n\n`,
      );
      await refresh(s);
      open(path);
    } catch (e) {
      fail(e);
    }
  }
  async function submit() {
    if (!modal) return;
    try {
      await flush();
      const p = input.trim();
      if (["create", "folder", "canvas", "rename"].includes(modal.kind) && !p)
        throw Error("이름을 입력해 주세요.");
      let s: VaultState | undefined,
        newPath = "";
      if (modal.kind === "create" || modal.kind === "canvas") {
        newPath =
          p +
          (modal.kind === "canvas"
            ? p.endsWith(".canvas")
              ? ""
              : ".canvas"
            : p.endsWith(".md")
              ? ""
              : ".md");
        s = await api.createFile(
          newPath,
          modal.kind === "canvas"
            ? JSON.stringify({ nodes: [], edges: [] }, null, 2)
            : "# " + titleOf(newPath) + "\n\n",
        );
      } else if (modal.kind === "folder") {
        s = await api.createFolder(p);
      } else if (modal.kind === "rename") {
        s = await api.rename(modal.path!, p);
        const remap = (x: string) =>
          x === modal.path || x.startsWith(modal.path + "/")
            ? p + x.slice(modal.path!.length)
            : x;
        setTabs((prev) => prev.map(remap));
        setActive((prev) => remap(prev));
        setBookmarks((prev) => prev.map(remap));
        history.current = history.current.map(remap);
        if (splitPath) setSplitPath(remap(splitPath));
      } else if (modal.kind === "delete") {
        s = await api.trash(modal.path!);
        const removed = (x: string) =>
          x === modal.path || x.startsWith(modal.path + "/");
        const next = tabs.filter((x) => !removed(x));
        setTabs(next);
        if (removed(active)) setActive(next[0] || "");
        if (splitPath && removed(splitPath)) setSplitPath(null);
        setBookmarks((prev) => prev.filter((x) => !removed(x)));
        notify("휴지통으로 이동했습니다. 설정에서 복원할 수 있습니다.");
      }
      if (s) await refresh(s);
      if (newPath) {
        open(newPath);
        if (modal.kind === "create") setMode("live");
      }
      setError("");
      setModal(null);
    } catch (e) {
      fail(e);
    }
  }
  async function switchVault(create = false) {
    try {
      await flush();
      const s = await (create ? api.createVault() : api.chooseVault());
      if (s) {
        await initialize(s);
        setModal(null);
      }
    } catch (e) {
      fail(e);
    }
  }
  async function attach() {
    if (vault?.editingPaths?.includes(active)) { setSharePath(active); return; }
    try {
      await flush();
      const added = await api.importFiles();
      if (added.length && isNote(active)) {
        edit(
          active,
          (docsRef.current[active] || "") +
            "\n" +
            added.map(attachmentMarkdown).join("\n\n") +
            "\n",
        );
        await refresh();
        notify("첨부 파일을 가져왔습니다.");
      }
    } catch (e) {
      fail(e);
    }
  }
  const toggleBookmark = (p: string) =>
    setBookmarks((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  const commands = [
    {
      name: "새 노트 만들기",
      detail: "⌘ N",
      icon: FilePlus2,
      run: () => show("create"),
    },
    {
      name: "새 캔버스 만들기",
      detail: "생각을 펼치는 공간",
      icon: LayoutDashboard,
      run: () => show("canvas"),
    },
    {
      name: "빠른 전환기",
      detail: "⌘ O",
      icon: Search,
      run: () => show("quick"),
    },
    {
      name: "그래프 뷰 열기",
      detail: "⌘ G",
      icon: Network,
      run: () => {
        open("@graph");
        setModal(null);
      },
    },
    {
      name: "오늘의 일일 노트",
      detail: "기록하는 습관",
      icon: CalendarDays,
      run: () => {
        void daily();
        setModal(null);
      },
    },
    {
      name: "모든 노트 검색",
      detail: "⌘ ⇧ F",
      icon: Search,
      run: () => {
        setLeft(true);
        setSection("search");
        setModal(null);
      },
    },
    {
      name: "편집 / 읽기 모드 전환",
      detail: "⌘ E",
      icon: BookOpen,
      run: () => {
        setMode((m) => (m === "preview" ? "live" : "preview"));
        setModal(null);
      },
    },
    {
      name: "오른쪽에 분할해서 열기",
      detail: "두 노트를 나란히",
      icon: Columns2,
      run: () => {
        setSplitPath(isNote(active) ? active : null);
        setModal(null);
      },
    },
    {
      name: "보관함 열기",
      detail: "로컬 폴더",
      icon: FolderOpen,
      run: () => {
        void switchVault();
      },
    },
    {
      name: "라이트 / 다크 테마",
      detail: "모양",
      icon: Sun,
      run: () => {
        setTheme((t) => (t === "dark" ? "light" : "dark"));
        setModal(null);
      },
    },
    {
      name: "설정",
      detail: "⌘ ,",
      icon: Settings,
      run: () => show("settings"),
    },
  ];
  const filteredCommands = commands.filter((c) =>
    c.name.toLowerCase().includes(input.toLowerCase()),
  );
  const quick = notes.filter((n) =>
    (n.title + " " + n.path).toLowerCase().includes(input.toLowerCase()),
  );
  const commandRef = useRef<(action: string) => void>(() => {});
  commandRef.current = (action) => {
    if (sharePath !== null) return;
    void switchVault(action === "createVault");
  };
  useEffect(
    () => api.onCommand?.((event) => commandRef.current(event.action)),
    [],
  );
  const actionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  actionRef.current = (e) => {
    if (sharePath !== null) return;
    if (e.key === "Escape") {
      setModal(null);
      setMenu(null);
      setError("");
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      void flush()
        .then(() => notify("모든 변경 내용을 저장했습니다."))
        .catch(fail);
    } else if (k === "n") {
      e.preventDefault();
      show(e.shiftKey ? "canvas" : "create");
    } else if (k === "p") {
      e.preventDefault();
      show("commands");
    } else if (k === "o") {
      e.preventDefault();
      show("quick");
    } else if (k === "g") {
      e.preventDefault();
      open("@graph");
    } else if (k === "e") {
      e.preventDefault();
      setMode((m) => (m === "preview" ? "live" : "preview"));
    } else if (k === ",") {
      e.preventDefault();
      show("settings");
    } else if (k === "f" && e.shiftKey) {
      e.preventDefault();
      setLeft(true);
      setSection("search");
    } else if (k === "w") {
      e.preventDefault();
      void closeTab(active);
    } else if (k === "t") {
      e.preventDefault();
      show("quick");
    } else if (k === "b" && e.shiftKey) {
      e.preventDefault();
      toggleBookmark(active);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => actionRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const activeContent = docs[active] || "",
    activeNote = isNote(active),
    activeCanvas = active.endsWith(".canvas");
  const activeMetadata = noteIndex.current.get(active, activeContent);
  const outLinks = activeMetadata.links;
  const backlinks = notes.filter(
    (n) =>
      n.path !== active &&
      n.metadata.links.some(
        (l) => resolveLink(l, n.path, paths) === active,
      ),
  );
  const outline = activeMetadata.headings;
  const allTags = useMemo(() => [...new Set(notes.flatMap((n) => n.metadata.tags))].sort(), [notes]);
  useEffect(() => noteIndex.current.retain(paths), [paths]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tag = q.startsWith("tag:") ? q.slice(4) : null;
    return notes
      .filter((n) =>
        tag
          ? n.metadata.tags.some((t) => t.toLowerCase().includes(tag))
          : (n.title + "\n" + n.content).toLowerCase().includes(q),
      )
      .map((n) => ({
        ...n,
        snippet:
          n.content
            .split("\n")
            .find((l) => l.toLowerCase().includes(tag ? "#" + tag : q))
            ?.replace(/[#*`\[\]]/g, "") || n.content.slice(0, 100),
      }));
  }, [query, notes]);
  function renderTree(parent = "", depth = 0) {
    const rows = (vault?.files || [])
      .filter((f) => f.path.split("/").slice(0, -1).join("/") === parent)
      .sort((a, b) =>
        a.type !== b.type
          ? a.type === "folder"
            ? -1
            : 1
          : sort === "modified"
            ? (b.mtime || 0) - (a.mtime || 0)
            : a.name.localeCompare(b.name, "ko"),
      );
    return rows.map((f) => {
      const folder = f.type === "folder",
        closed = collapsed.has(f.path);
      return (
        <div key={f.path}>
          <button
            className={"tree-row" + (active === f.path ? " selected" : "")}
            style={{ paddingLeft: 12 + depth * 16 }}
            title={f.path}
            onClick={() => {
              if (folder)
                setCollapsed((s) => {
                  const n = new Set(s);
                  closed ? n.delete(f.path) : n.add(f.path);
                  return n;
                });
              else if (noteTypes.test(f.path)) open(f.path);
              else notify("첨부 파일은 노트의 임베드로 확인할 수 있습니다.");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: f.path });
            }}
          >
            {folder ? (
              closed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )
            ) : f.path.endsWith(".canvas") ? (
              <LayoutDashboard size={14} />
            ) : (
              <FileText size={14} />
            )}
            <span>{folder ? f.name : titleOf(f.path)}</span>
            {bookmarks.includes(f.path) && <span className="tree-star">•</span>}
          </button>
          {folder && !closed && renderTree(f.path, depth + 1)}
        </div>
      );
    });
  }
  const wordCount = activeMetadata.wordCount ?? "—";
  return (
    <div className="app-shell" onClick={() => menu && setMenu(null)}>
      <div className="titlebar">
        <div className="titlebar-brand">
          <span className="brand-mark">◈</span> LITHOS
        </div>
        <span className="titlebar-center">
          {vault?.name || "보관함 여는 중"} <span>/</span>{" "}
          {active === "@graph" ? "그래프 뷰" : titleOf(active) || "새로운 생각"}
        </span>
        <span className="titlebar-caption">YOUR IDEAS, CONNECTED</span>
      </div>
      <div className="workspace">
        <nav className="ribbon" aria-label="앱 도구">
          <div>
            <IconButton
              icon={Files}
              label="파일 탐색기"
              active={left && section === "files"}
              onClick={() => {
                setLeft(true);
                setSection("files");
              }}
            />
            <IconButton
              icon={Search}
              label="빠른 전환기 (⌘ O)"
              onClick={() => show("quick")}
            />
            <IconButton
              icon={Network}
              label="그래프 뷰 (⌘ G)"
              active={active === "@graph"}
              onClick={() => open("@graph")}
            />
            <IconButton
              icon={LayoutDashboard}
              label="새 캔버스"
              onClick={() => show("canvas")}
            />
            <IconButton
              icon={CalendarDays}
              label="오늘의 일일 노트"
              onClick={() => void daily()}
            />
            <span className="ribbon-line" />
            <IconButton
              icon={Command}
              label="명령 팔레트 (⌘ P)"
              onClick={() => show("commands")}
            />
          </div>
          <div>
            <IconButton
              icon={FolderOpen}
              label="보관함 관리"
              onClick={() => show("vault")}
            />
            {api.getShares && (
              <IconButton
                icon={Share2}
                label="공유 링크 관리"
                onClick={() => setSharePath("")}
              />
            )}
            <IconButton
              icon={Settings}
              label="설정 (⌘ ,)"
              onClick={() => show("settings")}
            />
            <div className="avatar" title="로컬 보관함">
              L
            </div>
          </div>
        </nav>
        {left && (
          <aside className="left-sidebar">
            <div className="sidebar-tabs">
              <IconButton
                icon={Files}
                label="파일"
                active={section === "files"}
                onClick={() => setSection("files")}
              />
              <IconButton
                icon={Search}
                label="전체 검색"
                active={section === "search"}
                onClick={() => setSection("search")}
              />
              <IconButton
                icon={Bookmark}
                label="북마크"
                active={section === "bookmarks"}
                onClick={() => setSection("bookmarks")}
              />
              <span className="flex" />
              <IconButton
                icon={PanelLeftClose}
                label="왼쪽 사이드바 닫기"
                onClick={() => setLeft(false)}
              />
            </div>
            <div className="sidebar-label">
              {section === "files"
                ? "보관함"
                : section === "search"
                  ? "모든 노트 검색"
                  : "북마크"}
              <span>{section === "files" ? notes.length : ""}</span>
            </div>
            {section === "files" ? (
              <>
                <div className="file-tools">
                  <IconButton
                    icon={FilePlus2}
                    label="새 노트"
                    onClick={() => show("create")}
                  />
                  <IconButton
                    icon={FolderPlus}
                    label="새 폴더"
                    onClick={() => show("folder")}
                  />
                  <IconButton
                    icon={LayoutDashboard}
                    label="새 캔버스"
                    onClick={() => show("canvas")}
                  />
                  <button
                    className="sort-button"
                    onClick={() =>
                      setSort((s) => (s === "name" ? "modified" : "name"))
                    }
                  >
                    {sort === "name" ? "이름순" : "수정순"}{" "}
                    <ChevronDown size={12} />
                  </button>
                </div>
                <div className="tree">{renderTree()}</div>
                <button
                  className="new-note-button"
                  onClick={() => show("create")}
                >
                  <Plus size={16} /> 새 노트 <kbd>⌘ N</kbd>
                </button>
              </>
            ) : section === "search" ? (
              <>
                <div className="search-field">
                  <Search size={15} />
                  <input
                    autoFocus
                    placeholder="단어 또는 tag:태그"
                    aria-label="전체 노트 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      aria-label="검색 지우기"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="search-results">
                  {query && (
                    <div className="small-label">
                      {results.length}개 노트에서 발견
                    </div>
                  )}
                  {results.map((n) => (
                    <button
                      className="search-result"
                      key={n.path}
                      onClick={() => open(n.path)}
                    >
                      <strong>
                        <FileText size={13} />
                        {n.title}
                      </strong>
                      <span>{n.snippet.slice(0, 100)}</span>
                    </button>
                  ))}
                  {!query && (
                    <p className="empty-hint">
                      보관함의 제목과 내용을 검색하세요.
                      <br />
                      태그는 <code>tag:생각</code>으로 찾습니다.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="tree">
                {bookmarks.map((p) => (
                  <button
                    className={"tree-row" + (active === p ? " selected" : "")}
                    key={p}
                    onClick={() => open(p)}
                  >
                    <Bookmark size={14} />
                    <span>{titleOf(p)}</span>
                  </button>
                ))}
                {!bookmarks.length && (
                  <p className="empty-hint">
                    노트 상단의 북마크 버튼으로
                    <br />
                    자주 찾는 생각을 모으세요.
                  </p>
                )}
              </div>
            )}
            <button className="vault-footer" onClick={() => show("vault")}>
              <span className="vault-symbol">◈</span>
              <span>
                <strong>{vault?.name || "Lithos"}</strong>
                <small>
                  <span className="online-dot" /> 로컬 보관함
                </small>
              </span>
              <ChevronDown size={15} />
            </button>
          </aside>
        )}
        <main className="main-area">
          <div className="tabbar">
            {!left && (
              <IconButton
                icon={PanelLeftOpen}
                label="왼쪽 사이드바 열기"
                onClick={() => setLeft(true)}
              />
            )}
            <div className="tabs">
              {tabs.map((p) => (
                <div
                  key={p}
                  className={"tab" + (active === p ? " active" : "")}
                  onClick={() => open(p)}
                >
                  {p === "@graph" ? (
                    <Network size={14} />
                  ) : p.endsWith(".canvas") ? (
                    <LayoutDashboard size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>{p === "@graph" ? "그래프 뷰" : titleOf(p)}</span>
                  <button
                    title="탭 닫기"
                    aria-label={titleOf(p) + " 탭 닫기"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(p);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <IconButton
              icon={Plus}
              label="새 탭"
              onClick={() => show("quick")}
            />
            <span className="flex" />
            <IconButton
              icon={right ? PanelRightClose : PanelRightOpen}
              label="오른쪽 사이드바 전환"
              onClick={() => setRight((v) => !v)}
            />
          </div>
          <div className="pane-toolbar">
            <IconButton
              icon={ArrowLeft}
              label="뒤로"
              disabled={historyIndex.current <= 0}
              onClick={() => go(-1)}
            />
            <IconButton
              icon={ArrowRight}
              label="앞으로"
              disabled={historyIndex.current >= history.current.length - 1}
              onClick={() => go(1)}
            />
            <div className="breadcrumbs">
              {active === "@graph" ? (
                <>
                  <Network size={14} /> 그래프 뷰
                </>
              ) : (
                <>
                  <span>
                    {active.includes("/")
                      ? active.split("/").slice(0, -1).join(" / ")
                      : vault?.name}
                  </span>
                  <ChevronRight size={12} />
                  <strong>{titleOf(active)}</strong>
                </>
              )}
            </div>
            <span className="flex" />
            {activeNote && (
              <>
                <div className="mode-switch">
                  {(
                    [
                      { id: "live", icon: PenLine, label: "실시간 편집" },
                      { id: "source", icon: Code2, label: "원본" },
                      { id: "preview", icon: BookOpen, label: "읽기" },
                      { id: "split", icon: Columns2, label: "편집 + 미리보기" },
                    ] as const
                  ).map((m) => (
                    <IconButton
                      key={m.id}
                      icon={m.icon}
                      label={m.label}
                      active={mode === m.id}
                      onClick={() => setMode(m.id)}
                    />
                  ))}
                </div>
                {api.getShares && (
                  <IconButton
                    icon={Share2}
                    label="노트 공유"
                    onClick={() => setSharePath(active)}
                  />
                )}
                <IconButton
                  icon={Bookmark}
                  label="현재 노트 북마크"
                  active={bookmarks.includes(active)}
                  onClick={() => toggleBookmark(active)}
                />
              </>
            )}
            {active && active !== "@graph" && (
              <IconButton
                icon={MoreHorizontal}
                label="노트 메뉴"
                onClick={() =>
                  setMenu({
                    x: window.innerWidth - (right ? 300 : 80),
                    y: 112,
                    path: active,
                  })
                }
              />
            )}
          </div>
          {!window.vault && (
            <div className="demo-banner">
              브라우저 미리보기 · 실제 폴더를 사용하려면 Lithos 데스크톱 앱을
              실행하세요.
            </div>
          )}
          <div className="panes">
            <section className="document-pane">
              {!ready ? (
                <div className="empty-workspace" role="status">
                  <span className="empty-mark">◈</span>
                  <h1>보관함을 열고 있습니다</h1>
                  <p>노트와 연결된 생각을 불러오는 중입니다.</p>
                </div>
              ) : unreadable.has(active) ? (
                <div className="empty-workspace">
                  <AlertCircle size={35} />
                  <h1>노트를 읽을 수 없습니다</h1>
                  <p>기존 파일을 보호하기 위해 편집을 잠시 중지했습니다.</p>
                  <button
                    className="primary"
                    onClick={() => void refresh().catch(fail)}
                  >
                    다시 읽기
                  </button>
                </div>
              ) : active === "@graph" ? (
                <GraphView
                  notes={notes}
                  activePath={history.current.slice().reverse().find(isNote)}
                  onOpenNote={(p) => open(p)}
                />
              ) : activeCanvas ? (
                <CanvasView
                  key={active}
                  path={active}
                  paths={paths}
                  content={activeContent || '{"nodes":[],"edges":[]}'}
                  onChange={(c) => edit(active, c)}
                  notes={notes}
                  onOpenNote={(p) => open(p)}
                />
              ) : activeNote ? (
                <>
                  <div className="document-heading">
                    <div className="eyebrow">
                      <FileText size={12} /> MARKDOWN NOTE
                    </div>
                    <input
                      className="note-title"
                      aria-label="노트 제목"
                      value={titleOf(active)}
                      readOnly
                      onDoubleClick={() => show("rename", active)}
                      title="두 번 클릭하여 이름 변경"
                    />
                    <div className="note-meta">
                      <span>
                        <span className="online-dot" />{" "}
                        {saving ? "저장 중…" : "모든 변경 내용 저장됨"}
                      </span>
                      <span>{wordCount} 단어</span>
                      <button
                        onClick={() => {
                          setRight(true);
                          setRightTab("links");
                        }}
                      >
                        <Link2 size={12} /> {backlinks.length}개 백링크
                      </button>
                      <button
                        disabled={vault?.editingPaths?.includes(active)}
                        title="첨부 파일 가져오기"
                        onClick={() => void attach()}
                      >
                        <Paperclip size={13} />
                      </button>
                    </div>
                  </div>
                  {vault?.editingPaths?.includes(active) && <div className="collab-native-notice">
                    공동 편집 중인 노트입니다. 공유 창에서 링크를 열어 브라우저에서 함께 편집하세요.
                    <button onClick={() => setSharePath(active)}>공유 창 열기</button>
                  </div>}
                  <NoteEditor
                    key={vault?.root}
                    sessions={editorSessions.current}
                    content={activeContent}
                    onChange={(c) => edit(active, c)}
                    path={active}
                    paths={paths}
                    mode={vault?.editingPaths?.includes(active) ? "preview" : mode}
                    theme={theme}
                    fontSize={fontSize}
                    onLink={(s) => void openLink(s)}
                    jump={jump}
                  />
                </>
              ) : (
                <div className="empty-workspace">
                  <span className="empty-mark">◈</span>
                  <h1>다음 생각은 무엇인가요?</h1>
                  <p>새로운 노트를 쓰거나, 이어지는 생각을 찾아보세요.</p>
                  <button className="primary" onClick={() => show("create")}>
                    <Plus size={16} /> 새 노트 만들기
                  </button>
                  <button className="text-button" onClick={() => show("quick")}>
                    노트 찾아보기 <kbd>⌘ O</kbd>
                  </button>
                </div>
              )}
            </section>
            {splitPath && (
              <section className="split-pane">
                <div className="split-head">
                  <select
                    aria-label="분할 화면 노트"
                    value={splitPath}
                    onChange={(e) => setSplitPath(e.target.value)}
                  >
                    {notes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.title}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    icon={X}
                    label="분할 화면 닫기"
                    onClick={() => setSplitPath(null)}
                  />
                </div>
                <NoteEditor
                    sessions={splitSessions.current}
                  content={docs[splitPath] || ""}
                  onChange={(c) => edit(splitPath, c)}
                  path={splitPath}
                  paths={paths}
                  mode="preview"
                  theme={theme}
                  fontSize={fontSize}
                  onLink={(s) => void openLink(s, splitPath)}
                />
              </section>
            )}
          </div>
        </main>
        {right && (
          <aside className="right-sidebar">
            <div className="sidebar-tabs">
              <IconButton
                icon={Link2}
                label="링크"
                active={rightTab === "links"}
                onClick={() => setRightTab("links")}
              />
              <IconButton
                icon={List}
                label="개요"
                active={rightTab === "outline"}
                onClick={() => setRightTab("outline")}
              />
              <IconButton
                icon={Hash}
                label="태그"
                active={rightTab === "tags"}
                onClick={() => setRightTab("tags")}
              />
            </div>
            {rightTab === "links" ? (
              <>
                <div className="side-section">
                  <h3>
                    <ChevronDown size={13} />
                    백링크 <span>{backlinks.length}</span>
                  </h3>
                  {backlinks.length ? (
                    backlinks.map((n) => (
                      <button
                        className="backlink-card"
                        key={n.path}
                        onClick={() => open(n.path)}
                      >
                        <div>
                          <FileText size={13} />
                          {n.title}
                          <ArrowUpRight size={12} />
                        </div>
                        <p>
                          {n.content
                            .split("\n")
                            .find((l) =>
                              extractLinks(l).some(
                                (x) => resolveLink(x, n.path, paths) === active,
                              ),
                            )
                            ?.replace(/[[\]#*]/g, "")
                            .slice(0, 90)}
                        </p>
                      </button>
                    ))
                  ) : (
                    <p className="empty-hint">
                      이 노트를 연결하는 다른 노트가
                      <br />
                      여기에 표시됩니다.
                    </p>
                  )}
                </div>
                <div className="side-section">
                  <h3>
                    <ChevronDown size={13} />
                    나가는 링크 <span>{outLinks.length}</span>
                  </h3>
                  {outLinks.map((l, i) => (
                    <button
                      className="outgoing-link"
                      key={i}
                      onClick={() => void openLink(l)}
                    >
                      <Link2 size={13} />
                      {l.split("|").pop()?.split("/").pop()}
                      <ArrowUpRight size={11} />
                    </button>
                  ))}
                </div>
                <div className="side-section">
                  <h3>
                    <ChevronDown size={13} />이 노트의 태그
                  </h3>
                  <div className="tag-pills">
                    {activeMetadata.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setSection("search");
                          setLeft(true);
                          setQuery("tag:" + t);
                        }}
                      >
                        #{t}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="connection-tip">
                  <Network size={23} />
                  <strong>생각과 생각 사이</strong>
                  <p>
                    <code>[[노트 이름]]</code>을 입력해
                    <br />
                    새로운 연결을 만들어 보세요.
                  </p>
                  <button onClick={() => open("@graph")}>
                    연결 지도 보기 <ArrowUpRight size={12} />
                  </button>
                </div>
              </>
            ) : rightTab === "outline" ? (
              <div className="side-section">
                <h3>
                  문서 개요 <span>{outline.length}</span>
                </h3>
                {outline.map((h, i) => (
                  <button
                    className="outline-row"
                    key={i}
                    style={{ paddingLeft: (h.level - 1) * 12 + 4 }}
                    onClick={() =>
                      setJump({ offset: h.offset, tick: Date.now() })
                    }
                  >
                    {h.text}
                  </button>
                ))}
                {!outline.length && (
                  <p className="empty-hint">노트의 제목이 여기에 표시됩니다.</p>
                )}
              </div>
            ) : (
              <div className="side-section">
                <h3>
                  보관함 태그 <span>{allTags.length}</span>
                </h3>
                {allTags.map((t) => (
                  <button
                    className="tag-row"
                    key={t}
                    onClick={() => {
                      setLeft(true);
                      setSection("search");
                      setQuery("tag:" + t);
                    }}
                  >
                    <Hash size={13} />
                    {t}
                    <span>
                      {notes.filter((n) => n.metadata.tags.includes(t)).length}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
      <footer className="statusbar">
        <span>
          <span className="online-dot" /> 로컬에 안전하게 저장
        </span>
        <span>{notes.length}개 노트</span>
        <span className="flex" />
        {activeNote && (
          <>
            <span>
              {mode === "live"
                ? "실시간 편집"
                : mode === "source"
                  ? "Markdown 원본"
                  : mode === "preview"
                    ? "읽기 모드"
                    : "나란히 보기"}
            </span>
            <span>{wordCount} 단어</span>
            <span>{activeContent.length} 문자</span>
          </>
        )}
        <span className="status-saved">
          {saving ? (
            <>
              <RotateCcw size={11} />
              저장 중
            </>
          ) : (
            <>
              <CheckCheck size={12} />
              저장됨
            </>
          )}
        </span>
      </footer>
      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          {dirty.current.size > 0 && (
            <button
              onClick={() =>
                void flush()
                  .then(() => setError(""))
                  .catch(fail)
              }
            >
              다시 저장
            </button>
          )}
          <button aria-label="오류 닫기" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {menu && (
        <div
          className="context-menu"
          style={{
            left: Math.max(5, Math.min(menu.x, window.innerWidth - 235)),
            top: Math.min(menu.y, window.innerHeight - 255),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-caption">{titleOf(menu.path)}</div>
          <button onClick={() => show("rename", menu.path)}>
            <PenLine size={14} /> 이름 변경 / 이동
          </button>
          {noteTypes.test(menu.path) && (
            <>
              <button
                onClick={() => {
                  toggleBookmark(menu.path);
                  setMenu(null);
                }}
              >
                <Bookmark size={14} /> 북마크 전환
              </button>
              {isNote(menu.path) && (
                <button
                  onClick={() => {
                    setSplitPath(menu.path);
                    setMenu(null);
                  }}
                >
                  <Columns2 size={14} /> 오른쪽에 열기
                </button>
              )}
            </>
          )}
          <hr />
          <button className="danger" onClick={() => show("delete", menu.path)}>
            <Trash2 size={14} /> 휴지통으로 이동
          </button>
        </div>
      )}
      {sharePath !== null && (
        <ShareDialog
          path={sharePath}
          flush={flush}
          onClose={() => setSharePath(null)}
        />
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div
            className={"modal modal-" + modal.kind}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === "commands"
                ? "명령 팔레트"
                : modal.kind === "quick"
                  ? "빠른 전환기"
                  : "설정 및 파일 관리"
            }
          >
            {modal.kind === "quick" || modal.kind === "commands" ? (
              <>
                <div className="palette-input">
                  <Search size={20} />
                  <input
                    autoFocus
                    placeholder={
                      modal.kind === "quick"
                        ? "어떤 생각을 찾고 있나요?"
                        : "명령을 입력하세요…"
                    }
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setModalIndex(0);
                    }}
                    onKeyDown={(e) => {
                      const count =
                        modal.kind === "quick"
                          ? quick.length
                          : filteredCommands.length;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setModalIndex((i) => Math.min(count - 1, i + 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setModalIndex((i) => Math.max(0, i - 1));
                      } else if (e.key === "Enter") {
                        if (modal.kind === "quick") {
                          if (quick[modalIndex]) {
                            open(quick[modalIndex].path);
                            setModal(null);
                          } else if (input) {
                            show("create");
                            setInput(input);
                          }
                        } else filteredCommands[modalIndex]?.run();
                      }
                    }}
                  />
                  <kbd>esc</kbd>
                </div>
                <div className="palette-list">
                  <div className="small-label">
                    {modal.kind === "quick" ? "노트" : "사용 가능한 명령"}
                  </div>
                  {modal.kind === "quick"
                    ? quick.map((n, i) => (
                        <button
                          key={n.path}
                          className={i === modalIndex ? "highlighted" : ""}
                          onMouseEnter={() => setModalIndex(i)}
                          onClick={() => {
                            open(n.path);
                            setModal(null);
                          }}
                        >
                          <FileText size={16} />
                          <span>
                            {n.title}
                            <small>{n.path}</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))
                    : filteredCommands.map((c, i) => (
                        <button
                          key={c.name}
                          className={i === modalIndex ? "highlighted" : ""}
                          onMouseEnter={() => setModalIndex(i)}
                          onClick={c.run}
                        >
                          <c.icon size={16} />
                          <span>{c.name}</span>
                          <small>{c.detail}</small>
                        </button>
                      ))}
                  {modal.kind === "quick" && !quick.length && (
                    <button
                      onClick={() => {
                        show("create");
                        setInput(input);
                      }}
                    >
                      <Plus size={16} /> “{input}” 노트 만들기
                    </button>
                  )}
                </div>
                <div className="palette-footer">
                  <span>↑↓ 이동</span>
                  <span>↵ 열기</span>
                  <span>esc 닫기</span>
                </div>
              </>
            ) : modal.kind === "settings" ? (
              <>
                <div className="modal-header">
                  <h2>나의 작업 공간</h2>
                  <IconButton
                    icon={X}
                    label="설정 닫기"
                    onClick={() => setModal(null)}
                  />
                </div>
                <p className="modal-description">
                  당신의 생각에 맞는 공간으로 조정하세요.
                </p>
                <div className="setting-row">
                  <div>
                    <strong>모양</strong>
                    <small>편안하게 읽을 수 있는 테마</small>
                  </div>
                  <div className="theme-buttons">
                    <button
                      className={theme === "dark" ? "selected" : ""}
                      onClick={() => setTheme("dark")}
                    >
                      <Moon size={16} /> 다크
                    </button>
                    <button
                      className={theme === "light" ? "selected" : ""}
                      onClick={() => setTheme("light")}
                    >
                      <Sun size={16} /> 라이트
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>글자 크기</strong>
                    <small>{fontSize}px</small>
                  </div>
                  <input
                    aria-label="글자 크기"
                    type="range"
                    min="13"
                    max="24"
                    value={fontSize}
                    onChange={(e) => setFontSize(+e.target.value)}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>기본 편집 모드</strong>
                    <small>Markdown 노트 표시 방식</small>
                  </div>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as any)}
                  >
                    <option value="live">실시간 편집</option>
                    <option value="source">원본</option>
                    <option value="preview">읽기</option>
                    <option value="split">편집 + 미리보기</option>
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>보관함 휴지통</strong>
                    <small>삭제한 노트와 폴더 복원</small>
                  </div>
                  <button className="secondary" onClick={() => show("trash")}>
                    <Trash2 size={14} /> 열기
                  </button>
                </div>
                <div className="about-card">
                  <span className="brand-mark">◈</span>
                  <div>
                    <strong>
                      Lithos <span>1.0.0</span>
                    </strong>
                    <p>
                      Markdown과 JSON Canvas로 저장하는 로컬 지식 공간.
                      <br />
                      독립적으로 구현한 앱이며 Obsidian의
                      플러그인·Sync·Publish는 지원하지 않습니다.
                    </p>
                  </div>
                </div>
              </>
            ) : modal.kind === "vault" ? (
              <>
                <div className="modal-header">
                  <h2>생각이 머무는 곳</h2>
                  <IconButton
                    icon={X}
                    label="닫기"
                    onClick={() => setModal(null)}
                  />
                </div>
                <p className="modal-description">
                  보관함은 내 컴퓨터에 있는 평범한 폴더입니다.
                </p>
                <div className="vault-path">
                  <FolderOpen size={24} />
                  <div>
                    <strong>{vault?.name}</strong>
                    <small>{vault?.root}</small>
                  </div>
                </div>
                <button
                  className="vault-choice"
                  onClick={() => void switchVault()}
                >
                  <FolderOpen size={22} />
                  <span>
                    <strong>기존 보관함 열기</strong>
                    <small>Markdown 노트가 있는 폴더를 선택합니다.</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
                <button
                  className="vault-choice"
                  onClick={() => void switchVault(true)}
                >
                  <FolderPlus size={22} />
                  <span>
                    <strong>새 보관함 만들기</strong>
                    <small>새로운 지식 공간을 시작합니다.</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              </>
            ) : modal.kind === "trash" ? (
              <>
                <div className="modal-header">
                  <h2>보관함 휴지통</h2>
                  <IconButton
                    icon={X}
                    label="닫기"
                    onClick={() => setModal(null)}
                  />
                </div>
                {trashItems.length ? (
                  trashItems.map((item, i) => (
                    <div className="trash-row" key={item.id || i}>
                      <FileText size={16} />
                      <span>{item.originalPath || item.path || item.name}</span>
                      <button
                        className="secondary"
                        onClick={async () => {
                          try {
                            const s = await api.restoreTrash!(item.id);
                            await refresh(s);
                            setTrashItems(await api.getTrash!());
                            notify("파일을 복원했습니다.");
                          } catch (e) {
                            fail(e);
                          }
                        }}
                      >
                        복원
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="empty-hint">휴지통이 비어 있습니다.</p>
                )}
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className="modal-header">
                  <h2>
                    {modal.kind === "create"
                      ? "새로운 생각"
                      : modal.kind === "canvas"
                        ? "새 캔버스"
                        : modal.kind === "folder"
                          ? "새 폴더"
                          : modal.kind === "delete"
                            ? "휴지통으로 이동할까요?"
                            : "이름 변경 / 이동"}
                  </h2>
                  <IconButton
                    icon={X}
                    label="닫기"
                    onClick={() => setModal(null)}
                  />
                </div>
                <p className="modal-description">
                  {modal.kind === "delete"
                    ? `“${titleOf(modal.path || "")}” 항목을 이동합니다. 설정의 휴지통에서 복원할 수 있습니다.`
                    : modal.kind === "rename"
                      ? "폴더/파일명으로 경로를 지정하면 이동할 수 있습니다. 내부 링크도 함께 갱신됩니다."
                      : "이름을 입력하세요. 폴더/이름으로 경로를 지정할 수 있습니다."}
                </p>
                {modal.kind !== "delete" && (
                  <input
                    autoFocus
                    className="name-input"
                    aria-label="파일 이름"
                    placeholder={
                      modal.kind === "canvas"
                        ? "생각의 지도"
                        : modal.kind === "folder"
                          ? "프로젝트"
                          : "새로운 노트"
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                  />
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setModal(null)}
                  >
                    취소
                  </button>
                  <button
                    className={
                      modal.kind === "delete"
                        ? "primary destructive"
                        : "primary"
                    }
                    type="submit"
                  >
                    {modal.kind === "delete"
                      ? "휴지통으로 이동"
                      : modal.kind === "rename"
                        ? "변경하기"
                        : "만들기"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
