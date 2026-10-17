export const basename = (p: string) => p.split("/").pop() || p;
export const titleOf = (p: string) =>
  basename(p).replace(/\.(md|canvas)$/i, "");
export const isNote = (p: string) => /\.md$/i.test(p);
export function normalize(p: string) {
  const parts: string[] = [];
  for (const s of p.replace(/\\/g, "/").split("/")) {
    if (s === "..") parts.pop();
    else if (s && s !== ".") parts.push(s);
  }
  return parts.join("/");
}
export type LinkKind = "wiki" | "markdown";
export function decodeLinkPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function splitLink(raw: string, kind: LinkKind = "wiki") {
  const value = (kind === "wiki" ? raw.split("|")[0] : raw).trim();
  const index = value.indexOf("#");
  return {
    target: decodeLinkPart(
      (index < 0 ? value : value.slice(0, index)).split("?")[0],
    ),
    fragment: index < 0 ? "" : decodeLinkPart(value.slice(index + 1)),
  };
}
export function isExternalLink(value: string) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.trim());
}
/** Keep unsupported protocols out of local-note creation as well as the DOM. */
export function safeExternalUrl(value: string) {
  if (/[\u0000-\u0020\u007f]/.test(value.trim())) return null;
  try {
    const url = new URL(value.startsWith("//") ? "https:" + value : value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function withinVault(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}
export function resolveLink(
  raw: string,
  from: string,
  paths: string[],
  kind: LinkKind = "wiki",
) {
  const { target } = splitLink(raw, kind);
  if (isExternalLink(target) || /[\u0000-\u001f\u007f]/.test(target))
    return null;
  if (!target) return raw.includes("#") && paths.includes(from) ? from : null;
  const folder = from.split("/").slice(0, -1).join("/");
  const relative = withinVault((folder ? folder + "/" : "") + target);
  const absolute = withinVault(target);
  const explicitRelative = /^\.{1,2}(?:\/|$)/.test(target);
  const candidates = target.startsWith("/")
    ? [absolute]
    : kind === "markdown" || explicitRelative
      ? [relative]
      : [absolute, relative];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    for (const value of [candidate, candidate + ".md"]) {
      const found =
        paths.find((p) => p === value) ||
        paths.find((p) => p.toLocaleLowerCase() === value.toLocaleLowerCase());
      if (found) return found;
    }
  }
  if (kind === "markdown" || explicitRelative || target.includes("/"))
    return null;
  const name = target.replace(/\.md$/i, "").toLocaleLowerCase();
  const sourceParts = folder.split("/");
  const proximity = (p: string) => {
    const pieces = p.split("/");
    let n = 0;
    while (
      n < pieces.length - 1 &&
      n < sourceParts.length &&
      pieces[n] === sourceParts[n]
    )
      n++;
    return n;
  };
  return (
    paths
      .filter((p) => titleOf(p).toLocaleLowerCase() === name)
      .sort((a, b) => proximity(b) - proximity(a) || a.localeCompare(b))[0] ||
    null
  );
}
/** Convert local links to an unambiguous vault-root path for App's openLink callback. */
export function localLinkForNavigation(
  raw: string,
  from: string,
  paths: string[],
  kind: LinkKind = "wiki",
) {
  const parts = splitLink(raw, kind);
  if (
    isExternalLink(parts.target) ||
    /[\u0000-\u001f\u007f]/.test(parts.target)
  )
    return null;
  let target = resolveLink(raw, from, paths, kind);
  if (!target) {
    if (!parts.target) return null;
    const relative =
      kind === "markdown" || /^\.{1,2}(?:\/|$)/.test(parts.target);
    target = withinVault(
      relative && !parts.target.startsWith("/")
        ? from.split("/").slice(0, -1).concat(parts.target).join("/")
        : parts.target,
    );
  }
  return target
    ? "/" +
        target.split("/").map(encodeURIComponent).join("/") +
        (parts.fragment ? "#" + parts.fragment : "")
    : null;
}
/** Blank fenced/inline code and frontmatter without moving source offsets. */
export function maskMarkdownCode(text: string, inline = true) {
  const blank = (s: string) => s.replace(/[^\r\n]/g, " ");
  let fence: { character: string; length: number } | null = null;
  const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  const source = fm ? blank(fm[0]) + text.slice(fm[0].length) : text;
  let clean = source.replace(/[^\n]*(?:\n|$)/g, (line) => {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !line.slice(marker[0].length).trim()
      )
        fence = null;
      return blank(line);
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      return blank(line);
    }
    return line;
  });
  clean = clean.replace(/<!--[\s\S]*?-->/g, blank);
  return inline ? clean.replace(/(`+)([\s\S]*?)\1/g, blank) : clean;
}
export function extractLinks(text: string) {
  let clean = maskMarkdownCode(text);
  const references = new Map<string, string>();
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  clean = clean.replace(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(<[^>]+>|[^\s]+).*$/gm,
    (_line, label: string, target: string) => {
      references.set(key(label), target.replace(/^<|>$/g, ""));
      return "";
    },
  );
  const links: { at: number; raw: string; kind: LinkKind }[] = [];
  for (const match of clean.matchAll(/(?<!\\)!?\[\[([^\]\n]+)\]\]/g))
    links.push({ at: match.index!, raw: match[1], kind: "wiki" });
  for (const match of clean.matchAll(
    /(?<![\\\[])!?\[[^\]\n]*\]\([ \t]*(<[^>]+>|(?:[^\s()]|\([^()]*\))+)(?:[ \t]+["'][^\n]*?["'])?[ \t]*\)/g,
  ))
    links.push({
      at: match.index!,
      raw: match[1].replace(/^<|>$/g, ""),
      kind: "markdown",
    });
  for (const match of clean.matchAll(
    /(?<![\[\\])\[([^\[\]\n]+)\](?:\[([^\]\n]*)\])?(?![\[\](:])/g,
  )) {
    const raw = references.get(key(match[2] || match[1]));
    if (raw) links.push({ at: match.index!, raw, kind: "markdown" });
  }
  return links
    .sort((a, b) => a.at - b.at)
    .filter((link) => !isExternalLink(splitLink(link.raw, link.kind).target))
    .map((link) =>
      link.kind === "markdown" && !/^(?:\/|#|\.{1,2}\/)/.test(link.raw)
        ? "./" + link.raw
        : link.raw,
    );
}
function headingText(raw: string) {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(
      /\[\[([^\]]+)\]\]/g,
      (_, value: string) => value.split("|").pop() || "",
    )
    .replace(/[*_`~]/g, "")
    .trim();
}
export function headings(text: string) {
  return [
    ...maskMarkdownCode(text, false).matchAll(
      /^[ \t]{0,3}(#{1,6})[ \t]+(.+)$/gm,
    ),
  ].map((m) => ({
    level: m[1].length,
    text: headingText(m[2]),
    offset: (m.index || 0) + m[0].indexOf("#"),
  }));
}
export function findHeadingOffset(text: string, fragment: string) {
  const query = decodeLinkPart(fragment.replace(/^#/, ""));
  const normalizeHeading = (s: string) =>
    s
      .toLocaleLowerCase()
      .trim()
      .replace(/[ \t]+/g, " ");
  return headings(text).find(
    (h) =>
      normalizeHeading(h.text) === normalizeHeading(query) ||
      normalizeHeading(h.text).replace(/ /g, "-") === normalizeHeading(query),
  )?.offset;
}
export function toggleTaskAtOffset(
  content: string,
  offset: number,
  checked?: boolean,
) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= content.length)
    return content;
  const line = content.slice(offset).split("\n")[0];
  const match =
    /^(?:[ \t]*>[ \t]*)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|\r?$)/.exec(
      line,
    );
  if (!match) return content;
  const marker = offset + match[0].lastIndexOf("[") + 1;
  return (
    content.slice(0, marker) +
    ((checked ?? match[1] === " ") ? "x" : " ") +
    content.slice(marker + 1)
  );
}
export function tags(text: string) {
  return [
    ...new Set(
      [
        ...maskMarkdownCode(text).matchAll(/(?:^|\s)#([\p{L}\p{N}_\/-]+)/gu),
      ].map((m) => m[1]),
    ),
  ];
}
export const demoNotes: Record<string, string> = {
  "시작하기.md":
    "---\ntags: 시작, 가이드\n---\n# 생각을 연결하는 공간\n\n작은 메모 하나에서, 더 큰 생각으로. **Lithos**는 내 컴퓨터에 저장하는 나만의 지식 공간입니다.\n\n> 생각은 연결될 때 더 선명해집니다.\n\n## 나만의 보관함\n\n노트는 평범한 Markdown 파일입니다. 왼쪽의 **+** 버튼으로 새 노트를 만들거나, 이 페이지를 바로 편집해 보세요. 변경 내용은 자동으로 저장됩니다.\n\n## 다음 아이디어로\n\n- [[아이디어 정원]]에서 생각의 씨앗을 모으세요.\n- [[프로젝트/작은 시작]]에서 계획을 구체화하세요.\n- [[연결의 힘]]에서 링크가 만드는 흐름을 살펴보세요.\n\n## 오늘 해볼 일\n\n- [x] 나만의 공간 둘러보기\n- [ ] 첫 번째 노트 작성하기\n- [ ] 두 노트를 링크로 연결하기\n- [ ] 캔버스에 아이디어 펼치기\n\n---\n\n`⌘ O` 빠른 전환 · `⌘ P` 명령 팔레트 · `⌘ N` 새 노트\n\n#시작 #생각",
  "아이디어 정원.md":
    "# 아이디어 정원\n\n아직 다 자라지 않은 생각들을 모아 두는 곳.\n\n## 씨앗\n- 매일 한 문장 기록하기\n- 좋아하는 문장과 내 생각 연결하기\n- [[프로젝트/작은 시작|작은 시작]]을 반복하기\n\n## 연결\n[[연결의 힘]]은 꾸준한 기록에서 시작됩니다.\n\n#아이디어 #기록",
  "연결의 힘.md":
    "# 연결의 힘\n\n서로 다른 생각이 만날 때 새로운 관점이 생깁니다.\n\n[[아이디어 정원]]에서 발견한 생각을 [[프로젝트/작은 시작]]으로 옮겨 보세요.\n\n## 링크 만들기\n`[[노트 이름]]`으로 다른 노트를 연결합니다.\n\n#생각 #연결",
  "프로젝트/작은 시작.md":
    "# 작은 시작\n\n완벽한 계획보다 오늘의 작은 한 걸음.\n\n## 진행 상황\n- [x] 아이디어 정리\n- [ ] 첫 번째 초안\n- [ ] 다시 읽고 다듬기\n\n| 단계 | 목표 |\n| --- | --- |\n| 발견 | [[아이디어 정원]] |\n| 연결 | [[연결의 힘]] |\n| 실행 | 작은 시도 |\n\n#프로젝트",
  "생각의 지도.canvas": JSON.stringify(
    {
      nodes: [
        {
          id: "a",
          type: "text",
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          text: "나의 다음 아이디어\n\n어떤 생각을 연결하고 싶나요?",
          color: "6",
        },
        {
          id: "b",
          type: "file",
          file: "아이디어 정원.md",
          x: 420,
          y: -80,
          width: 270,
          height: 150,
        },
        {
          id: "c",
          type: "file",
          file: "프로젝트/작은 시작.md",
          x: 420,
          y: 170,
          width: 270,
          height: 150,
        },
      ],
      edges: [
        {
          id: "ab",
          fromNode: "a",
          toNode: "b",
          fromSide: "right",
          toSide: "left",
          label: "발견",
        },
        {
          id: "ac",
          fromNode: "a",
          toNode: "c",
          fromSide: "right",
          toSide: "left",
          label: "실행",
        },
      ],
    },
    null,
    2,
  ),
};
