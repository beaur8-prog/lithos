import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  Link2,
  Maximize2,
  Minus,
  Move,
  Pencil,
  Plus,
  Redo2,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { MarkdownPreview } from "./NoteEditor";
import { resolveLink } from "../model";
import "./canvas.css";

type Side = "left" | "right" | "top" | "bottom";
type CanvasNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
  [key: string]: unknown;
};
type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  label?: string;
  color?: string;
  [key: string]: unknown;
};
type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
};
type View = { x: number; y: number; zoom: number };
type Point = { x: number; y: number };
type PointerAction =
  | { type: "pan"; pointerId: number; start: Point; view: View }
  | {
      type: "move";
      pointerId: number;
      start: Point;
      nodes: CanvasNode[];
      moved: boolean;
    }
  | {
      type: "resize";
      pointerId: number;
      start: Point;
      node: CanvasNode;
      moved: boolean;
    };

export interface CanvasViewProps {
  content: string;
  onChange: (next: string) => void;
  notes: { path: string; title: string; content?: string }[];
  onOpenNote: (path: string) => void;
  /** Vault-relative canvas path and inventory provide context for embeds/links. */
  path?: string;
  paths?: string[];
}

const EMPTY: CanvasDocument = { nodes: [], edges: [] };
const COLORS = [
  { value: "", label: "기본", css: "var(--lc-card)" },
  { value: "1", label: "빨강", css: "#e86a76" },
  { value: "2", label: "주황", css: "#e8a25e" },
  { value: "3", label: "노랑", css: "#dac66e" },
  { value: "4", label: "초록", css: "#74b98b" },
  { value: "5", label: "청록", css: "#65b8ca" },
  { value: "6", label: "보라", css: "#a48ce1" },
];
const SIDES: Side[] = ["top", "right", "bottom", "left"];
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const colorFor = (color?: string) =>
  COLORS.find((item) => item.value === color)?.css ||
  (/^#[a-f\d]{6}$/i.test(color || "") ? color! : "var(--accent, #a78bfa)");
const editableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable="true"]');

function parseCanvas(content: string): {
  document: CanvasDocument;
  error: string | null;
} {
  if (!content.trim()) return { document: EMPTY, error: null };
  try {
    const parsed = JSON.parse(content);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) {
      throw new Error(
        "nodes와 edges 배열이 있는 JSON Canvas 문서가 필요합니다.",
      );
    }
    const ids = new Set<string>();
    for (const node of parsed.nodes) {
      if (
        !node ||
        typeof node.id !== "string" ||
        typeof node.type !== "string" ||
        !["x", "y", "width", "height"].every(
          (key) => typeof node[key] === "number" && Number.isFinite(node[key]),
        ) ||
        node.width <= 0 ||
        node.height <= 0
      ) {
        throw new Error(
          "카드의 id, type, 위치 또는 크기 값이 올바르지 않습니다.",
        );
      }
      if (ids.has(node.id))
        throw new Error(`중복된 카드 ID가 있습니다: ${node.id}`);
      if (
        ["text", "file", "url", "label", "color"].some(
          (key) => node[key] !== undefined && typeof node[key] !== "string",
        )
      )
        throw new Error(
          "카드의 text, file, url, label, color 값은 문자열이어야 합니다.",
        );
      ids.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const edge of parsed.edges) {
      if (
        !edge ||
        typeof edge.id !== "string" ||
        typeof edge.fromNode !== "string" ||
        typeof edge.toNode !== "string"
      )
        throw new Error(
          "연결의 id, fromNode 또는 toNode 값이 올바르지 않습니다.",
        );
      if (edgeIds.has(edge.id))
        throw new Error(`중복된 연결 ID가 있습니다: ${edge.id}`);
      if (
        ["label", "color"].some(
          (key) => edge[key] !== undefined && typeof edge[key] !== "string",
        )
      )
        throw new Error("연결의 label, color 값은 문자열이어야 합니다.");
      edgeIds.add(edge.id);
    }
    return { document: parsed as CanvasDocument, error: null };
  } catch (error) {
    return {
      document: EMPTY,
      error:
        error instanceof Error
          ? error.message
          : "JSON 문서를 읽을 수 없습니다.",
    };
  }
}

function anchor(node: CanvasNode, side: Side): Point {
  if (side === "left") return { x: node.x, y: node.y + node.height / 2 };
  if (side === "right")
    return { x: node.x + node.width, y: node.y + node.height / 2 };
  if (side === "top") return { x: node.x + node.width / 2, y: node.y };
  return { x: node.x + node.width / 2, y: node.y + node.height };
}

function curve(from: Point, to: Point, fromSide: Side, toSide: Side) {
  const offset = clamp(Math.hypot(to.x - from.x, to.y - from.y) * 0.4, 50, 220);
  const control = (point: Point, side: Side) => ({
    x: point.x + (side === "left" ? -offset : side === "right" ? offset : 0),
    y: point.y + (side === "top" ? -offset : side === "bottom" ? offset : 0),
  });
  const a = control(from, fromSide);
  const b = control(to, toSide);
  return {
    path: `M ${from.x} ${from.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${to.x} ${to.y}`,
    middle: {
      x: (from.x + 3 * a.x + 3 * b.x + to.x) / 8,
      y: (from.y + 3 * a.y + 3 * b.y + to.y) / 8,
    },
  };
}

export default function CanvasView({
  content,
  onChange,
  notes,
  onOpenNote,
  path = "",
  paths,
}: CanvasViewProps) {
  const [initial] = useState(() => parseCanvas(content));
  const [document, setDocument] = useState<CanvasDocument>(initial.document);
  const documentRef = useRef(document);
  const [error, setError] = useState<string | null>(initial.error);
  const [recoveryDraft, setRecoveryDraft] = useState(content);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [view, setView] = useState<View>({ x: 60, y: 60, zoom: 1 });
  const viewRef = useRef(view);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connecting, setConnecting] = useState<{
    nodeId: string;
    side: Side;
  } | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const historyRef = useRef<{
    past: CanvasDocument[];
    future: CanvasDocument[];
  }>({ past: [], future: [] });
  const stageRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<PointerAction | null>(null);
  const didFit = useRef(false);
  const markerId = useRef(`lc-arrow-${newId()}`);

  function updateView(next: View) {
    viewRef.current = next;
    setView(next);
  }

  function recordHistory() {
    historyRef.current.past.push(documentRef.current);
    if (historyRef.current.past.length > 100) historyRef.current.past.shift();
    historyRef.current.future = [];
    setHistoryVersion((value) => value + 1);
  }

  function commit(next: CanvasDocument, record = true) {
    if (record) recordHistory();
    documentRef.current = next;
    setDocument(next);
    const serialized = JSON.stringify(next, null, 2);
    lastEmitted.current = serialized;
    onChangeRef.current(serialized);
  }

  function stopPointerAction() {
    const pointerId = actionRef.current?.pointerId;
    actionRef.current = null;
    setDragging(false);
    if (
      pointerId !== undefined &&
      stageRef.current?.hasPointerCapture(pointerId)
    )
      stageRef.current.releasePointerCapture(pointerId);
  }

  function undo() {
    stopPointerAction();
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.push(documentRef.current);
    commit(previous, false);
    setSelectedIds((ids) =>
      ids.filter((id) => previous.nodes.some((node) => node.id === id)),
    );
    setSelectedEdge((id) =>
      previous.edges.some((edge) => edge.id === id) ? id : null,
    );
    setEditingId(null);
    setConnecting(null);
    setHistoryVersion((value) => value + 1);
  }

  function redo() {
    stopPointerAction();
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(documentRef.current);
    commit(next, false);
    setSelectedIds((ids) =>
      ids.filter((id) => next.nodes.some((node) => node.id === id)),
    );
    setSelectedEdge((id) =>
      next.edges.some((edge) => edge.id === id) ? id : null,
    );
    setEditingId(null);
    setConnecting(null);
    setHistoryVersion((value) => value + 1);
  }

  useEffect(() => {
    if (content === lastEmitted.current) return;
    // Once external content is accepted, an older local serialization is no
    // longer an echo. Otherwise an external revert to that value is ignored.
    lastEmitted.current = null;
    stopPointerAction();
    const parsed = parseCanvas(content);
    documentRef.current = parsed.document;
    setDocument(parsed.document);
    setError(parsed.error);
    setRecoveryDraft(content);
    setRecoveryError(null);
    setSelectedIds([]);
    setSelectedEdge(null);
    setEditingId(null);
    setConnecting(null);
    historyRef.current = { past: [], future: [] };
    setHistoryVersion((value) => value + 1);
  }, [content]);

  function worldPoint(clientX: number, clientY: number): Point {
    const rect = stageRef.current?.getBoundingClientRect();
    return {
      x:
        (clientX - (rect?.left || 0) - viewRef.current.x) /
        viewRef.current.zoom,
      y:
        (clientY - (rect?.top || 0) - viewRef.current.y) / viewRef.current.zoom,
    };
  }

  function zoomAt(nextZoom: number, point?: Point) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = point || { x: rect.width / 2, y: rect.height / 2 };
    const current = viewRef.current;
    const zoom = clamp(nextZoom, 0.15, 3);
    updateView({
      x: center.x - ((center.x - current.x) * zoom) / current.zoom,
      y: center.y - ((center.y - current.y) * zoom) / current.zoom,
      zoom,
    });
  }

  function fitView() {
    const rect = stageRef.current?.getBoundingClientRect();
    const nodes = documentRef.current.nodes;
    if (!rect || !nodes.length) {
      updateView({ x: 60, y: 60, zoom: 1 });
      return;
    }
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    const zoom = clamp(
      Math.min(
        (rect.width - 140) / (right - left),
        (rect.height - 170) / (bottom - top),
      ),
      0.15,
      1.25,
    );
    updateView({
      x: rect.width / 2 - ((left + right) / 2) * zoom,
      y: rect.height / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    });
  }

  useEffect(() => {
    if (didFit.current || !document.nodes.length || error) return;
    const frame = requestAnimationFrame(() => {
      fitView();
      didFit.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [document.nodes.length, error]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (actionRef.current) {
        event.preventDefault();
        return;
      }
      if (editableTarget(event.target)) return;
      const scrollable =
        event.target instanceof Element
          ? event.target.closest(".lc-card-text")
          : null;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        scrollable &&
        scrollable.scrollHeight > scrollable.clientHeight
      )
        return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (
        event.ctrlKey ||
        event.metaKey ||
        (!event.shiftKey && Math.abs(event.deltaY) > 0 && event.deltaX === 0)
      ) {
        zoomAt(viewRef.current.zoom * Math.exp(-event.deltaY * 0.002), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else {
        const current = viewRef.current;
        updateView({
          ...current,
          x:
            current.x -
            (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX),
          y: current.y - (event.shiftKey ? 0 : event.deltaY),
        });
      }
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [error]);

  function patchNode(id: string, patch: Partial<CanvasNode>, record = true) {
    commit(
      {
        ...documentRef.current,
        nodes: documentRef.current.nodes.map((node) =>
          node.id === id ? { ...node, ...patch } : node,
        ),
      },
      record,
    );
  }

  function addNode(type: "text" | "file", file?: string) {
    const rect = stageRef.current?.getBoundingClientRect();
    const width = 290;
    const height = type === "file" ? 190 : 230;
    const center = {
      x: ((rect?.width || 700) / 2 - viewRef.current.x) / viewRef.current.zoom,
      y: ((rect?.height || 500) / 2 - viewRef.current.y) / viewRef.current.zoom,
    };
    const node: CanvasNode = {
      id: newId(),
      type,
      x: Math.round(center.x - width / 2),
      y: Math.round(center.y - height / 2),
      width,
      height,
      ...(type === "text" ? { text: "" } : { file }),
    };
    // A small cascade keeps successive new cards from completely covering one another.
    while (
      documentRef.current.nodes.some(
        (existing) =>
          Math.abs(existing.x - node.x) < 15 &&
          Math.abs(existing.y - node.y) < 15,
      )
    ) {
      node.x += 30;
      node.y += 30;
    }
    commit({
      ...documentRef.current,
      nodes: [...documentRef.current.nodes, node],
    });
    setSelectedIds([node.id]);
    setSelectedEdge(null);
    setEditingId(type === "text" ? node.id : null);
    setPickerOpen(false);
    setPickerQuery("");
  }

  function removeSelection() {
    if (!selectedIds.length && !selectedEdge) return;
    const ids = new Set(selectedIds);
    commit({
      ...documentRef.current,
      nodes: documentRef.current.nodes.filter((node) => !ids.has(node.id)),
      edges: documentRef.current.edges.filter(
        (edge) =>
          edge.id !== selectedEdge &&
          !ids.has(edge.fromNode) &&
          !ids.has(edge.toNode),
      ),
    });
    setSelectedIds([]);
    setSelectedEdge(null);
    setEditingId(null);
    setConnecting(null);
  }

  function connectTo(nodeId: string, side: Side) {
    if (!connecting) {
      const node = documentRef.current.nodes.find((item) => item.id === nodeId);
      if (node) setCursor(anchor(node, side));
      setConnecting({ nodeId, side });
      setSelectedIds([nodeId]);
      return;
    }
    if (connecting.nodeId === nodeId) return;
    const edge: CanvasEdge = {
      id: newId(),
      fromNode: connecting.nodeId,
      toNode: nodeId,
      fromSide: connecting.side,
      toSide: side,
    };
    commit({
      ...documentRef.current,
      edges: [...documentRef.current.edges, edge],
    });
    setConnecting(null);
    setConnectMode(false);
    setSelectedIds([]);
    setSelectedEdge(edge.id);
  }

  function selectNode(event: ReactPointerEvent, node: CanvasNode) {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (connectMode || connecting) {
      connectTo(node.id, connecting ? "left" : "right");
      return;
    }
    if (editingId !== node.id) stageRef.current?.focus({ preventScroll: true });
    setSelectedEdge(null);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      setSelectedIds((current) =>
        current.includes(node.id)
          ? current.filter((id) => id !== node.id)
          : [...current, node.id],
      );
    } else if (!selectedIds.includes(node.id)) {
      setSelectedIds([node.id]);
      setEditingId(null);
    }
  }

  function startMove(event: ReactPointerEvent, node: CanvasNode) {
    if (
      event.button !== 0 ||
      (event.target instanceof HTMLElement && event.target.closest("button"))
    )
      return;
    event.stopPropagation();
    if (connectMode || connecting) {
      connectTo(node.id, connecting ? "left" : "right");
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      selectNode(event, node);
      return;
    }
    const ids = selectedIds.includes(node.id) ? selectedIds : [node.id];
    setSelectedIds(ids);
    setSelectedEdge(null);
    setEditingId(null);
    stageRef.current?.focus({ preventScroll: true });
    stageRef.current?.setPointerCapture(event.pointerId);
    actionRef.current = {
      type: "move",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      nodes: documentRef.current.nodes.filter((item) => ids.includes(item.id)),
      moved: false,
    };
  }

  function startResize(event: ReactPointerEvent, node: CanvasNode) {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0) return;
    setSelectedIds([node.id]);
    setSelectedEdge(null);
    stageRef.current?.setPointerCapture(event.pointerId);
    actionRef.current = {
      type: "resize",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      node,
      moved: false,
    };
  }

  function startPan(event: ReactPointerEvent) {
    if (event.button !== 0 && event.button !== 1) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        ".lc-toolbar, .lc-zoom, .lc-selection-tools, .lc-picker, .lc-empty",
      )
    )
      return;
    event.preventDefault();
    stageRef.current?.focus({ preventScroll: true });
    if (event.button === 0) {
      setSelectedIds([]);
      setSelectedEdge(null);
      setEditingId(null);
    }
    stageRef.current?.setPointerCapture(event.pointerId);
    actionRef.current = {
      type: "pan",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      view: viewRef.current,
    };
    setDragging(true);
  }

  function pointerMove(event: ReactPointerEvent) {
    if (connecting) setCursor(worldPoint(event.clientX, event.clientY));
    const action = actionRef.current;
    if (!action || action.pointerId !== event.pointerId) return;
    const dx = event.clientX - action.start.x;
    const dy = event.clientY - action.start.y;
    if (action.type === "pan") {
      updateView({
        ...action.view,
        x: action.view.x + dx,
        y: action.view.y + dy,
      });
      return;
    }
    if (!action.moved && Math.hypot(dx, dy) < 3) return;
    if (!action.moved) {
      recordHistory();
      action.moved = true;
      setDragging(true);
    }
    if (action.type === "move") {
      const positions = new Map(action.nodes.map((node) => [node.id, node]));
      commit(
        {
          ...documentRef.current,
          nodes: documentRef.current.nodes.map((node) => {
            const original = positions.get(node.id);
            return original
              ? {
                  ...node,
                  x: Math.round(original.x + dx / viewRef.current.zoom),
                  y: Math.round(original.y + dy / viewRef.current.zoom),
                }
              : node;
          }),
        },
        false,
      );
    } else {
      patchNode(
        action.node.id,
        {
          width: Math.max(
            180,
            Math.round(action.node.width + dx / viewRef.current.zoom),
          ),
          height: Math.max(
            130,
            Math.round(action.node.height + dy / viewRef.current.zoom),
          ),
        },
        false,
      );
    }
  }

  function finishPointer(event: ReactPointerEvent) {
    if (actionRef.current?.pointerId !== event.pointerId) return;
    stopPointerAction();
  }

  const selectedNode =
    selectedIds.length === 1
      ? document.nodes.find((node) => node.id === selectedIds[0])
      : undefined;
  const edge = document.edges.find((item) => item.id === selectedEdge);
  const linkingNode = connecting
    ? document.nodes.find((node) => node.id === connecting.nodeId)
    : undefined;
  const filteredNotes = notes.filter((note) =>
    `${note.title} ${note.path}`
      .toLowerCase()
      .includes(pickerQuery.toLowerCase()),
  );
  const notePaths = paths || notes.map((note) => note.path);
  function openLinkedNote(target: string, source = path) {
    const resolved = resolveLink(target, source, notePaths);
    if (resolved) onOpenNote(resolved);
  }
  // The version state redraws undo/redo controls without storing duplicate history in React.
  void historyVersion;

  if (error)
    return (
      <div className="lc-recovery">
        <div className="lc-recovery-heading">
          <StickyNote size={25} />
          <h2>캔버스를 읽을 수 없습니다</h2>
        </div>
        <p>
          원본 내용은 유지되어 있습니다. 아래 JSON을 수정하고 적용하면 캔버스를
          다시 열 수 있습니다.
        </p>
        <div className="lc-recovery-error" role="alert">
          {recoveryError || error}
        </div>
        <textarea
          aria-label="복구할 캔버스 JSON"
          spellCheck={false}
          value={recoveryDraft}
          onChange={(event) => setRecoveryDraft(event.target.value)}
        />
        <button
          className="lc-primary"
          onClick={() => {
            const parsed = parseCanvas(recoveryDraft);
            if (parsed.error) {
              setRecoveryError(parsed.error);
              return;
            }
            setError(null);
            setRecoveryError(null);
            didFit.current = false;
            // Invalid source cannot be represented as a CanvasDocument undo step.
            // Start a clean history instead of making undo replace it with EMPTY.
            historyRef.current = { past: [], future: [] };
            setHistoryVersion((value) => value + 1);
            commit(parsed.document, false);
          }}
        >
          <Check size={16} />
          수정한 JSON 적용
        </button>
      </div>
    );

  return (
    <div
      className={`lc-canvas${dragging ? " lc-dragging" : ""}${connectMode || connecting ? " lc-connecting" : ""}`}
      ref={stageRef}
      tabIndex={0}
      role="region"
      aria-label="캔버스 편집기"
      onPointerDown={startPan}
      onPointerMove={pointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={finishPointer}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          stopPointerAction();
          setEditingId(null);
          setConnecting(null);
          setConnectMode(false);
          setPickerOpen(false);
          stageRef.current?.focus();
          return;
        }
        if (editableTarget(event.target)) return;
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          removeSelection();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSelectedIds(document.nodes.map((node) => node.id));
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) redo();
          else undo();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "0") {
          event.preventDefault();
          fitView();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          (event.key === "+" || event.key === "=")
        ) {
          event.preventDefault();
          zoomAt(view.zoom * 1.2);
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "-") {
          event.preventDefault();
          zoomAt(view.zoom / 1.2);
        }
      }}
      style={{
        backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <div
        className="lc-toolbar"
        role="toolbar"
        aria-label="캔버스 도구"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          title="텍스트 카드 추가"
          aria-label="텍스트 카드 추가"
          onClick={() => addNode("text")}
        >
          <StickyNote size={17} />
          <span>텍스트</span>
          <Plus size={13} />
        </button>
        <button
          title="보관함 노트 추가"
          aria-label="보관함 노트 추가"
          onClick={() => {
            setPickerOpen((open) => !open);
            setPickerQuery("");
          }}
        >
          <FileText size={17} />
          <span>노트</span>
          <Plus size={13} />
        </button>
        <span className="lc-divider" />
        <button
          className={connectMode ? "lc-active" : ""}
          title="카드 연결 — 시작 카드와 도착 카드를 선택하세요"
          aria-label="카드 연결"
          aria-pressed={connectMode}
          onClick={() => {
            setConnectMode(!connectMode);
            setConnecting(null);
            setEditingId(null);
          }}
        >
          <Link2 size={17} />
          <span>연결</span>
        </button>
        <span className="lc-divider" />
        <button
          className="lc-icon-button"
          title="실행 취소 (⌘Z)"
          aria-label="실행 취소"
          disabled={!historyRef.current.past.length}
          onClick={undo}
        >
          <Undo2 size={16} />
        </button>
        <button
          className="lc-icon-button"
          title="다시 실행 (⇧⌘Z)"
          aria-label="다시 실행"
          disabled={!historyRef.current.future.length}
          onClick={redo}
        >
          <Redo2 size={16} />
        </button>
      </div>

      {pickerOpen && (
        <div
          className="lc-picker"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="lc-picker-heading">
            <span>보관함에서 노트 추가</span>
            <button
              className="lc-icon-button"
              aria-label="노트 선택 닫기"
              onClick={() => setPickerOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <input
            autoFocus
            aria-label="캔버스에 추가할 노트 검색"
            placeholder="노트 검색…"
            value={pickerQuery}
            onChange={(event) => setPickerQuery(event.target.value)}
          />
          <div className="lc-picker-list">
            {filteredNotes.map((note) => (
              <button
                key={note.path}
                onClick={() => addNode("file", note.path)}
              >
                <FileText size={16} />
                <span>
                  <strong>{note.title}</strong>
                  <small>{note.path}</small>
                </span>
                <Plus size={15} />
              </button>
            ))}
            {!filteredNotes.length && <p>추가할 노트가 없습니다.</p>}
          </div>
        </div>
      )}

      <div
        className="lc-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        <svg className="lc-edges" aria-label="카드 간 연결">
          <defs>
            <marker
              id={markerId.current}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke" />
            </marker>
          </defs>
          {document.edges.map((item) => {
            const from = document.nodes.find(
              (node) => node.id === item.fromNode,
            );
            const to = document.nodes.find((node) => node.id === item.toNode);
            if (!from || !to) return null;
            const fromSide = SIDES.includes(item.fromSide as Side)
              ? item.fromSide!
              : "right";
            const toSide = SIDES.includes(item.toSide as Side)
              ? item.toSide!
              : "left";
            const geometry = curve(
              anchor(from, fromSide),
              anchor(to, toSide),
              fromSide,
              toSide,
            );
            return (
              <g
                key={item.id}
                className={`lc-edge${selectedEdge === item.id ? " lc-selected-edge" : ""}`}
                style={item.color ? { color: colorFor(item.color) } : undefined}
              >
                <path
                  className="lc-edge-line"
                  d={geometry.path}
                  markerStart={
                    item.fromEnd === "arrow"
                      ? `url(#${markerId.current})`
                      : undefined
                  }
                  markerEnd={
                    item.toEnd === "none"
                      ? undefined
                      : `url(#${markerId.current})`
                  }
                />
                <path
                  className="lc-edge-hit"
                  d={geometry.path}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    item.label ? `연결: ${item.label}` : "카드 연결 선택"
                  }
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    stageRef.current?.focus();
                    setSelectedEdge(item.id);
                    setSelectedIds([]);
                    setEditingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setSelectedEdge(item.id);
                      setSelectedIds([]);
                    }
                  }}
                />
                {!!item.label && (
                  <g
                    className="lc-edge-label"
                    transform={`translate(${geometry.middle.x}, ${geometry.middle.y})`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      stageRef.current?.focus();
                      setSelectedEdge(item.id);
                      setSelectedIds([]);
                      setEditingId(null);
                    }}
                  >
                    <rect
                      x={-Math.min(160, item.label.length * 5 + 14)}
                      y={-13}
                      width={Math.min(320, item.label.length * 10 + 28)}
                      height={26}
                      rx={6}
                    />
                    <text textAnchor="middle" dominantBaseline="central">
                      {item.label.length > 28
                        ? `${item.label.slice(0, 28)}…`
                        : item.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {linkingNode && connecting && (
            <path
              className="lc-pending-edge"
              d={
                curve(
                  anchor(linkingNode, connecting.side),
                  cursor,
                  connecting.side,
                  "left",
                ).path
              }
              markerEnd={`url(#${markerId.current})`}
            />
          )}
        </svg>

        {document.nodes.map((node) => {
          const selected = selectedIds.includes(node.id);
          const editing = editingId === node.id;
          const title =
            node.type === "file"
              ? notes.find((note) => note.path === node.file)?.title ||
                node.file?.split("/").pop()?.replace(/\.md$/, "") ||
                "연결된 파일"
              : node.type === "group"
                ? node.label || "그룹"
                : node.type === "link"
                  ? "웹 링크"
                  : "텍스트";
          return (
            <div
              key={node.id}
              className={`lc-card lc-card-${node.type}${selected ? " lc-selected" : ""}${editing ? " lc-editing" : ""}${node.color ? " lc-colored" : ""}`}
              style={
                {
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  ...(node.color
                    ? { "--lc-node-color": colorFor(node.color) }
                    : {}),
                } as React.CSSProperties
              }
              onPointerDown={(event) => selectNode(event, node)}
              onDoubleClick={() => {
                if (connectMode || connecting) return;
                if (node.type === "file" && node.file) onOpenNote(node.file);
                if (node.type === "text") {
                  setEditingId(node.id);
                  setSelectedIds([node.id]);
                }
              }}
            >
              <div
                className="lc-card-header"
                onPointerDown={(event) => startMove(event, node)}
              >
                {node.type === "file" ? (
                  <FileText size={14} />
                ) : node.type === "text" ? (
                  <StickyNote size={14} />
                ) : (
                  <Move size={14} />
                )}
                <span>{title}</span>
                {node.type === "text" && (
                  <button
                    className="lc-icon-button"
                    title={editing ? "편집 완료" : "텍스트 편집"}
                    aria-label={editing ? "카드 편집 완료" : "카드 텍스트 편집"}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      setSelectedIds([node.id]);
                      setEditingId(editing ? null : node.id);
                    }}
                  >
                    {editing ? <Check size={14} /> : <Pencil size={13} />}
                  </button>
                )}
                {node.type === "file" && node.file && (
                  <button
                    className="lc-icon-button"
                    title="노트 열기"
                    aria-label={`${title} 노트 열기`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onOpenNote(node.file!)}
                  >
                    <ArrowUpRight size={15} />
                  </button>
                )}
              </div>
              {node.type === "text" ? (
                editing ? (
                  <textarea
                    className="lc-card-editor"
                    aria-label="카드 텍스트"
                    autoFocus
                    spellCheck={false}
                    placeholder="아이디어를 적어보세요…"
                    value={node.text || ""}
                    onPointerDown={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      patchNode(node.id, { text: event.target.value })
                    }
                  />
                ) : (
                  <div
                    className={`lc-card-text${!node.text ? " lc-placeholder" : ""}`}
                  >
                    {node.text ? (
                      <MarkdownPreview
                        content={node.text}
                        path={path}
                        paths={notePaths}
                        onLink={openLinkedNote}
                        onChange={(text) => patchNode(node.id, { text })}
                      />
                    ) : (
                      "두 번 클릭하여 아이디어를 적어보세요."
                    )}
                  </div>
                )
              ) : node.type === "file" ? (
                notes.find((note) => note.path === node.file)?.content !==
                undefined ? (
                  <div className="lc-card-text lc-note-preview">
                    <MarkdownPreview
                      content={
                        notes.find((note) => note.path === node.file)!.content!
                      }
                      path={node.file || ""}
                      paths={notePaths}
                      onLink={(target) => openLinkedNote(target, node.file)}
                    />
                  </div>
                ) : (
                  <div className="lc-file-card-body">
                    <div className="lc-file-emblem">
                      <FileText size={27} strokeWidth={1.4} />
                    </div>
                    <strong>{title}</strong>
                    <span>{node.file}</span>
                    <small>
                      두 번 클릭하여 노트 열기 <ArrowUpRight size={11} />
                    </small>
                  </div>
                )
              ) : node.type === "link" ? (
                <div className="lc-card-text">
                  <span className="lc-external-url">
                    {node.url || "웹 링크"}
                  </span>
                </div>
              ) : node.type === "group" ? (
                <div className="lc-group-body">{node.label || ""}</div>
              ) : (
                <div className="lc-card-text lc-placeholder">
                  {node.type} 카드 · 원본 데이터가 유지됩니다.
                </div>
              )}
              {SIDES.map((side) => (
                <button
                  key={side}
                  className={`lc-port lc-port-${side}${connecting?.nodeId === node.id && connecting.side === side ? " lc-port-active" : ""}`}
                  title="다른 카드와 연결"
                  aria-label={`${title} ${side} 연결 포트`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCursor(anchor(node, side));
                    connectTo(node.id, side);
                  }}
                />
              ))}
              <div
                className="lc-resize"
                role="button"
                tabIndex={0}
                aria-label={`${title} 카드 크기 조절`}
                title="드래그하여 크기 조절 · 방향키로 미세 조절"
                onPointerDown={(event) => startResize(event, node)}
                onKeyDown={(event) => {
                  const steps: Record<
                    string,
                    { width?: number; height?: number }
                  > = {
                    ArrowRight: { width: node.width + 10 },
                    ArrowLeft: { width: Math.max(180, node.width - 10) },
                    ArrowDown: { height: node.height + 10 },
                    ArrowUp: { height: Math.max(130, node.height - 10) },
                  };
                  if (steps[event.key]) {
                    event.preventDefault();
                    event.stopPropagation();
                    patchNode(node.id, steps[event.key]);
                  }
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <path d="M3 10 10 3M7 10l3-3" />
                </svg>
              </div>
            </div>
          );
        })}
      </div>

      {!document.nodes.length && (
        <div
          className="lc-empty"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="lc-empty-illustration">
            <span />
            <span />
            <span />
            <svg viewBox="0 0 220 115">
              <path d="M58 58 C95 58 100 32 138 32M58 58 C95 58 100 90 138 90" />
            </svg>
          </div>
          <h2>생각을 펼치는 공간</h2>
          <p>
            노트와 아이디어를 연결해서
            <br />
            새로운 관점을 발견하세요.
          </p>
          <button className="lc-primary" onClick={() => addNode("text")}>
            <Plus size={17} />첫 카드 추가
          </button>
          <small>자유롭게 배치하고, 연결하고, 확장하세요.</small>
        </div>
      )}

      {(selectedIds.length > 0 || edge) && !pickerOpen && (
        <div
          className="lc-selection-tools"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="lc-selection-label">
            {edge
              ? "연결"
              : selectedIds.length > 1
                ? `${selectedIds.length}개 카드`
                : selectedNode?.type === "file"
                  ? "노트 카드"
                  : "카드"}
          </span>
          {edge && (
            <input
              aria-label="연결 이름"
              placeholder="연결 이름…"
              value={edge.label || ""}
              onChange={(event) =>
                commit({
                  ...documentRef.current,
                  edges: documentRef.current.edges.map((item) =>
                    item.id === edge.id
                      ? { ...item, label: event.target.value }
                      : item,
                  ),
                })
              }
            />
          )}
          <div className="lc-color-options" aria-label="색상 선택">
            {COLORS.map((color) => (
              <button
                key={color.value}
                className={`lc-color-option${(edge?.color || selectedNode?.color || "") === color.value ? " lc-color-selected" : ""}`}
                style={{ background: color.css }}
                title={`${color.label} 색상`}
                aria-label={`${color.label} 색상`}
                onClick={() => {
                  if (edge)
                    commit({
                      ...documentRef.current,
                      edges: documentRef.current.edges.map((item) =>
                        item.id === edge.id
                          ? { ...item, color: color.value || undefined }
                          : item,
                      ),
                    });
                  else
                    commit({
                      ...documentRef.current,
                      nodes: documentRef.current.nodes.map((node) =>
                        selectedIds.includes(node.id)
                          ? { ...node, color: color.value || undefined }
                          : node,
                      ),
                    });
                }}
              />
            ))}
          </div>
          <span className="lc-divider" />
          <button
            className="lc-icon-button lc-delete"
            title="선택 삭제 (⌫)"
            aria-label="선택한 카드 또는 연결 삭제"
            onClick={removeSelection}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}

      <div className="lc-canvas-hint">
        {connecting
          ? "연결할 카드 또는 포트를 선택하세요 · Esc 취소"
          : connectMode
            ? "시작 카드를 선택하세요 · Esc 취소"
            : "배경 드래그로 이동 · 스크롤로 확대 · ⇧ 클릭으로 다중 선택"}
      </div>
      <div
        className="lc-zoom"
        role="toolbar"
        aria-label="캔버스 보기"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="lc-icon-button"
          aria-label="축소"
          title="축소"
          onClick={() => zoomAt(view.zoom / 1.2)}
        >
          <Minus size={16} />
        </button>
        <button
          className="lc-zoom-value"
          title="원래 크기로 보기"
          aria-label={`확대 비율 ${Math.round(view.zoom * 100)}%, 클릭하면 100%`}
          onClick={() => zoomAt(1)}
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          className="lc-icon-button"
          aria-label="확대"
          title="확대"
          onClick={() => zoomAt(view.zoom * 1.2)}
        >
          <Plus size={16} />
        </button>
        <span className="lc-divider" />
        <button
          className="lc-icon-button"
          aria-label="모든 카드에 맞추기"
          title="전체 보기 (⌘0)"
          onClick={fitView}
        >
          <Maximize2 size={16} />
        </button>
      </div>
    </div>
  );
}
