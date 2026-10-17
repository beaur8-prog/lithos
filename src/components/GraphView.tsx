import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Focus,
  Maximize2,
  Minus,
  Network,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import "./graph.css";

type Note = { path: string; title: string; content: string };
type GraphNode = { id: string; title: string; degree: number };
type GraphEdge = { source: string; target: string };
type Point = { x: number; y: number };
type SimNode = GraphNode & Point & { vx: number; vy: number; fixed: boolean };
type Camera = { x: number; y: number; scale: number };

export type GraphViewProps = {
  notes: Note[];
  activePath?: string;
  onOpenNote: (path: string) => void;
};

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function pathKey(value: string): string {
  return normalizePath(value)
    .replace(/\.(md|markdown)$/i, "")
    .toLocaleLowerCase();
}

function withoutCode(content: string): string {
  let fence: { character: string; length: number } | null = null;
  return content
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.character &&
          marker[1].length >= fence.length &&
          !line.slice(marker[0].length).trim()
        )
          fence = null;
        return "";
      }
      if (marker) {
        fence = { character: marker[1][0], length: marker[1].length };
        return "";
      }
      if (/^(?: {4}|\t)/.test(line) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(line))
        return "";
      return line;
    })
    .join("\n")
    .replace(/(`+)([\s\S]*?)\1/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Derive only existing-note links; an edge represents a link in either direction. */
export function deriveNoteGraph(notes: Note[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const paths = new Map(notes.map((note) => [pathKey(note.path), note.path]));
  const basenames = new Map<string, string[]>();
  for (const note of notes) {
    const name = pathKey(note.path).split("/").pop()!;
    basenames.set(name, [...(basenames.get(name) ?? []), note.path]);
  }

  function resolve(
    raw: string,
    from: string,
    markdown: boolean,
  ): string | undefined {
    let target = raw.trim();
    if (target.startsWith("<") && target.endsWith(">"))
      target = target.slice(1, -1);
    try {
      target = decodeURIComponent(target);
    } catch {
      /* Keep malformed URI text literal. */
    }
    target = target.split("#")[0].split("?")[0];
    if (
      !target ||
      /^[a-z][a-z\d+.-]*:/i.test(target) ||
      target.startsWith("//")
    )
      return;
    const folder = from.includes("/")
      ? from.slice(0, from.lastIndexOf("/") + 1)
      : "";
    const relative = paths.get(pathKey(folder + target));
    const absolute = paths.get(pathKey(target));
    const exact = target.startsWith("/")
      ? absolute
      : markdown
        ? (relative ?? absolute)
        : (absolute ?? relative);
    if (exact) return exact;
    // Markdown paths have explicit relative semantics; wiki links allow shortest-name resolution.
    if (markdown || target.includes("/")) return;
    const candidates = basenames.get(pathKey(target));
    if (!candidates?.length) return;
    const fromParts = folder.split("/");
    const proximity = (candidate: string) => {
      const parts = candidate.split("/");
      let common = 0;
      while (
        common < parts.length - 1 &&
        common < fromParts.length &&
        parts[common] === fromParts[common]
      )
        common++;
      return common;
    };
    return [...candidates].sort(
      (a, b) => proximity(b) - proximity(a) || a.localeCompare(b),
    )[0];
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const degree = new Map(notes.map((note) => [note.path, 0]));
  for (const note of notes) {
    let prose = withoutCode(note.content);
    const links: { target: string; markdown: boolean }[] = [];
    const references = new Map<string, string>();
    const referenceKey = (value: string) =>
      value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    prose = prose.replace(
      /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>]+>|[^\s]+).*$/gm,
      (_line, label: string, target: string) => {
        if (!references.has(referenceKey(label)))
          references.set(referenceKey(label), target);
        return "";
      },
    );
    for (const match of prose.matchAll(/\[\[([^\]\n]+)\]\]/g))
      links.push({ target: match[1].split("|")[0], markdown: false });
    for (const match of prose.matchAll(
      /\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
    ))
      links.push({ target: match[1], markdown: true });
    for (const match of prose.matchAll(
      /(?<![\[\\])\[([^\[\]\n]+)\](?:\[([^\]\n]*)\])?(?![\[\](:])/g,
    )) {
      const target = references.get(referenceKey(match[2] || match[1]));
      if (target) links.push({ target, markdown: true });
    }
    for (const link of links) {
      const target = resolve(link.target, note.path, link.markdown);
      if (!target || target === note.path) continue;
      const [source, destination] = [note.path, target].sort();
      const key = JSON.stringify([source, destination]);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target: destination });
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(destination, (degree.get(destination) ?? 0) + 1);
    }
  }
  return {
    nodes: notes.map((note) => ({
      id: note.path,
      title: note.title,
      degree: degree.get(note.path) ?? 0,
    })),
    edges,
  };
}

export function GraphView({ notes, activePath, onOpenNote }: GraphViewProps) {
  const graph = useMemo(() => deriveNoteGraph(notes), [notes]);
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState(false);
  const [depth, setDepth] = useState(1);
  const [labels, setLabels] = useState(true);
  const [filter, setFilter] = useState<"all" | "connected" | "orphans">("all");
  const [settings, setSettings] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [, renderFrame] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const simulation = useRef<SimNode[]>([]);
  const cameraRef = useRef(camera);
  const heat = useRef(1);
  const drag = useRef<{
    id: string | null;
    pointerId: number;
    start: Point;
    origin: Point;
    moved: boolean;
  } | null>(null);
  const didFit = useRef(false);
  const activeLocal =
    local && !!activePath && graph.nodes.some((node) => node.id === activePath);

  const visible = useMemo(() => {
    let reachable: Set<string> | null = null;
    if (activeLocal && activePath) {
      let frontier = new Set<string>([activePath]);
      for (let step = 0; step < depth; step++) {
        const next: Set<string> = new Set(frontier);
        for (const edge of graph.edges) {
          if (frontier.has(edge.source)) next.add(edge.target);
          if (frontier.has(edge.target)) next.add(edge.source);
        }
        frontier = next;
      }
      reachable = frontier;
    }
    const search = query.toLocaleLowerCase().trim();
    const nodes = graph.nodes.filter(
      (node) =>
        (!reachable || reachable.has(node.id)) &&
        (!search ||
          node.title.toLocaleLowerCase().includes(search) ||
          node.id.toLocaleLowerCase().includes(search)) &&
        (filter === "all" ||
          (filter === "connected" ? node.degree > 0 : node.degree === 0)),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graph.edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      ),
    };
  }, [graph, query, filter, activePath, activeLocal, depth]);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = new Map(simulation.current.map((node) => [node.id, node]));
    const count = visible.nodes.length;
    simulation.current = visible.nodes.map((node, i) => {
      const old = previous.get(node.id);
      const radius = count === 1 ? 0 : Math.sqrt(i + 1) * 43;
      const angle = i * 2.399963229728653;
      return {
        ...node,
        x: old?.x ?? Math.cos(angle) * radius,
        y: old?.y ?? Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fixed: false,
      };
    });
    heat.current = 1;
    if (!didFit.current && count) {
      didFit.current = true;
      setCamera({
        x: 0,
        y: 0,
        scale: Math.max(
          0.15,
          Math.min(
            1.2,
            Math.min(size.width, size.height) / (Math.sqrt(count) * 105 + 110),
          ),
        ),
      });
    }
    const nodes = simulation.current;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = visible.edges.map((edge) => ({
      a: byId.get(edge.source)!,
      b: byId.get(edge.target)!,
    }));
    let frame = 0;
    let tick = 0;
    let disposed = false;
    function animate() {
      if (disposed) return;
      if (heat.current > 0.002 || drag.current?.id) {
        const alpha = Math.max(heat.current, drag.current?.id ? 0.25 : 0);
        // Sample repulsion for large vaults so pointer interaction remains responsive.
        const stride = Math.max(1, Math.floor(nodes.length / 250));
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1 + (tick % stride); j < nodes.length; j += stride) {
            const b = nodes[j];
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            if (dx === 0 && dy === 0) {
              dx = 0.1;
              dy = 0.1;
            }
            const d2 = Math.max(100, dx * dx + dy * dy);
            const strength = Math.min(5, (2200 * stride * alpha) / d2);
            const distance = Math.sqrt(d2);
            a.vx += (dx / distance) * strength;
            a.vy += (dy / distance) * strength;
            b.vx -= (dx / distance) * strength;
            b.vy -= (dy / distance) * strength;
          }
        }
        for (const { a, b } of edges) {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const force = (distance - 115) * 0.018 * alpha;
          a.vx += (dx / distance) * force;
          a.vy += (dy / distance) * force;
          b.vx -= (dx / distance) * force;
          b.vy -= (dy / distance) * force;
        }
        for (const node of nodes) {
          node.vx = (node.vx - node.x * 0.0015 * alpha) * 0.78;
          node.vy = (node.vy - node.y * 0.0015 * alpha) * 0.78;
          if (!node.fixed) {
            node.x += node.vx;
            node.y += node.vy;
          }
        }
        heat.current *= 0.982;
        tick++;
        renderFrame(tick);
      }
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
    // Dimensions affect initial fitting only. Resizing must preserve the user's layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      setCamera((previous) => {
        const nextScale = Math.max(
          0.08,
          Math.min(4, previous.scale * Math.exp(-event.deltaY * 0.002)),
        );
        const ratio = nextScale / previous.scale;
        return {
          scale: nextScale,
          x: point.x - (point.x - previous.x) * ratio,
          y: point.y - (point.y - previous.y) * ratio,
        };
      });
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const positioned = new Map(simulation.current.map((node) => [node.id, node]));
  const highlighted = hovered ?? activePath;
  const neighbors = new Set<string>();
  if (highlighted) {
    neighbors.add(highlighted);
    for (const edge of visible.edges) {
      if (edge.source === highlighted) neighbors.add(edge.target);
      if (edge.target === highlighted) neighbors.add(edge.source);
    }
  }

  function fitGraph() {
    const nodes = simulation.current;
    if (!nodes.length) {
      setCamera({ x: 0, y: 0, scale: 1 });
      return;
    }
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    const scale = Math.max(
      0.08,
      Math.min(
        1.6,
        (size.width - 180) / Math.max(100, maxX - minX),
        (size.height - 180) / Math.max(100, maxY - minY),
      ),
    );
    setCamera({
      x: (-(minX + maxX) / 2) * scale,
      y: (-(minY + maxY) / 2) * scale,
      scale,
    });
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const target = (event.target as Element).closest("[data-note-id]");
    const id =
      event.button === 0
        ? (target?.getAttribute("data-note-id") ?? null)
        : null;
    const node = id ? positioned.get(id) : null;
    drag.current = {
      id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: node
        ? { x: node.x, y: node.y }
        : { x: cameraRef.current.x, y: cameraRef.current.y },
      moved: false,
    };
    if (node) {
      node.fixed = true;
      heat.current = 0.5;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (Math.hypot(dx, dy) > 4) current.moved = true;
    if (current.id) {
      const node = positioned.get(current.id);
      if (node) {
        node.x = current.origin.x + dx / cameraRef.current.scale;
        node.y = current.origin.y + dy / cameraRef.current.scale;
      }
      heat.current = 0.5;
    } else
      setCamera((previous) => ({
        ...previous,
        x: current.origin.x + dx,
        y: current.origin.y + dy,
      }));
  }

  function pointerUp(
    event: ReactPointerEvent<SVGSVGElement>,
    cancelled = false,
  ) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const node = current.id ? positioned.get(current.id) : null;
    if (node) node.fixed = false;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && current.id && !current.moved) onOpenNote(current.id);
  }

  return (
    <section className="lithos-graph" aria-label="노트 그래프">
      <header className="graph-toolbar">
        <div
          className="graph-view-switch"
          role="group"
          aria-label="그래프 범위"
        >
          <button
            className={!activeLocal ? "is-active" : ""}
            onClick={() => setLocal(false)}
          >
            <Network size={15} /> 전체 그래프
          </button>
          <button
            className={activeLocal ? "is-active" : ""}
            disabled={
              !activePath || !graph.nodes.some((node) => node.id === activePath)
            }
            title={
              activePath ? "현재 노트의 연결 보기" : "노트를 먼저 열어 주세요"
            }
            onClick={() => setLocal(true)}
          >
            <Focus size={15} /> 로컬 그래프
          </button>
        </div>
        <label className="graph-search">
          <Search size={14} />
          <input
            aria-label="그래프에서 노트 검색"
            placeholder="노트 필터…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="필터 지우기" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>
        <button
          className={`graph-icon-button ${settings ? "is-active" : ""}`}
          title="그래프 설정"
          aria-label="그래프 설정"
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
        >
          <SlidersHorizontal size={17} />
        </button>
      </header>
      <div className="graph-stage" ref={container}>
        <svg
          ref={svg}
          className="graph-svg"
          width="100%"
          height="100%"
          aria-label={`${visible.nodes.length}개 노트, ${visible.edges.length}개 연결. 노드를 클릭하면 노트를 엽니다.`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={(event) => pointerUp(event)}
          onPointerCancel={(event) => pointerUp(event, true)}
          onPointerLeave={() => {
            if (!drag.current) setHovered(null);
          }}
        >
          <g
            transform={`translate(${size.width / 2 + camera.x},${size.height / 2 + camera.y}) scale(${camera.scale})`}
          >
            <g className="graph-edges">
              {visible.edges.map((edge) => {
                const a = positioned.get(edge.source);
                const b = positioned.get(edge.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={JSON.stringify([edge.source, edge.target])}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    vectorEffect="non-scaling-stroke"
                    className={
                      highlighted &&
                      (edge.source === highlighted ||
                        edge.target === highlighted)
                        ? "is-highlighted"
                        : hovered
                          ? "is-dimmed"
                          : ""
                    }
                  />
                );
              })}
            </g>
            <g className="graph-nodes">
              {visible.nodes.map((node) => {
                const point = positioned.get(node.id);
                if (!point) return null;
                const radius = 5 + Math.min(8, Math.sqrt(node.degree) * 1.6);
                const active = node.id === activePath;
                const highlightedNode = node.id === hovered;
                return (
                  <g
                    key={node.id}
                    data-note-id={node.id}
                    transform={`translate(${point.x},${point.y})`}
                    className={`graph-node ${active ? "is-active" : ""} ${highlightedNode ? "is-hovered" : ""} ${hovered && !neighbors.has(node.id) ? "is-dimmed" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.title}, 연결 ${node.degree}개. 노트 열기`}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenNote(node.id);
                      }
                    }}
                    onPointerEnter={() => setHovered(node.id)}
                    onPointerLeave={() => {
                      if (!drag.current?.id) setHovered(null);
                    }}
                  >
                    <title>
                      {node.id}
                      {"\n"}연결 {node.degree}개
                    </title>
                    <circle
                      className="graph-node-hit"
                      r={Math.max(15, radius + 6)}
                    />
                    {active && (
                      <circle className="graph-node-halo" r={radius + 7} />
                    )}
                    <circle className="graph-node-dot" r={radius} />
                    {(labels || highlightedNode || active) && (
                      <text
                        y={radius + 17}
                        textAnchor="middle"
                        fontSize={Math.max(
                          10,
                          Math.min(14, 12 / Math.sqrt(camera.scale)),
                        )}
                      >
                        {node.title.length > 35
                          ? `${node.title.slice(0, 34)}…`
                          : node.title}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        {!visible.nodes.length && (
          <div className="graph-empty">
            <Network size={38} strokeWidth={1} />
            <strong>
              {notes.length ? "일치하는 노트가 없어요" : "생각을 연결해 보세요"}
            </strong>
            <p>
              {notes.length
                ? "검색어나 연결 필터를 바꿔 보세요."
                : "노트를 만들고 [[노트 이름]]으로 연결하면 여기에 나타납니다."}
            </p>
            {notes.length > 0 && (
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  setLocal(false);
                }}
              >
                필터 초기화
              </button>
            )}
          </div>
        )}
        {settings && (
          <aside className="graph-settings" aria-label="그래프 설정 패널">
            <div className="graph-settings-title">
              그래프 설정
              <button
                className="graph-icon-button"
                aria-label="설정 닫기"
                onClick={() => setSettings(false)}
              >
                <X size={14} />
              </button>
            </div>
            <label>
              표시할 노트
              <select
                aria-label="연결 필터"
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as typeof filter)
                }
              >
                <option value="all">모든 노트</option>
                <option value="connected">연결된 노트</option>
                <option value="orphans">연결 없는 노트</option>
              </select>
            </label>
            <label className="graph-checkbox">
              <span>노트 이름 표시</span>
              <input
                type="checkbox"
                checked={labels}
                onChange={(event) => setLabels(event.target.checked)}
              />
            </label>
            {activeLocal && (
              <label>
                연결 깊이
                <select
                  aria-label="로컬 그래프 깊이"
                  value={depth}
                  onChange={(event) => setDepth(Number(event.target.value))}
                >
                  <option value={1}>1단계</option>
                  <option value={2}>2단계</option>
                  <option value={3}>3단계</option>
                </select>
              </label>
            )}
            <p>
              노드 크기는 연결 수를 나타냅니다. 현재 노트는 보라색으로
              표시됩니다.
            </p>
          </aside>
        )}
        <div className="graph-legend">
          <span className="graph-legend-dot" />
          {activeLocal ? "현재 노트의 연결" : "나의 지식 네트워크"}
          <span className="graph-legend-separator">·</span>
          {visible.nodes.length}개 노트
          <span className="graph-legend-separator">·</span>
          {visible.edges.length}개 연결
        </div>
        <div className="graph-navigation">
          <button
            className="graph-icon-button"
            aria-label="그래프 축소"
            title="축소"
            onClick={() =>
              setCamera((previous) => ({
                ...previous,
                scale: Math.max(0.08, previous.scale / 1.25),
              }))
            }
          >
            <Minus size={16} />
          </button>
          <span>{Math.round(camera.scale * 100)}%</span>
          <button
            className="graph-icon-button"
            aria-label="그래프 확대"
            title="확대"
            onClick={() =>
              setCamera((previous) => ({
                ...previous,
                scale: Math.min(4, previous.scale * 1.25),
              }))
            }
          >
            <Plus size={16} />
          </button>
          <i />
          <button
            className="graph-icon-button"
            aria-label="그래프 전체 보기"
            title="전체 보기"
            onClick={fitGraph}
          >
            <Maximize2 size={15} />
          </button>
        </div>
        <div className="graph-help">
          드래그로 이동 · 스크롤로 확대 · 노트를 클릭해 열기
        </div>
      </div>
    </section>
  );
}

export default GraphView;
