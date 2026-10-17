"use strict";
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { resolveLink, normalizePath } = require("./vault.cjs");
const imageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

const MAX_DOWNLOAD = 250 * 1024 * 1024;
const MAX_TOTAL = 500 * 1024 * 1024;

async function snapshot(vault, source, { includeFiles = false, downloadDirectory } = {}) {
  source = normalizePath(source);
  if (!/\.md$/i.test(source))
    throw new Error("마크다운 노트만 공유할 수 있습니다.");
  await vault.queue;
  const raw = await vault.readFile(source);
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("공유할 본문은 1 MB 이하로 줄여 주세요.");
  const content = raw.replace(
    /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/,
    "",
  );
  const [{ unified }, { default: parse }, { default: gfm }, { default: math }] =
    await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("remark-gfm"),
      import("remark-math"),
    ]);
  const tree = unified().use(parse).use(gfm).use(math).parse(content);
  const definitions = new Map();
  const refs = new Map();
  const fileRefs = new Map();
  function definitionsIn(node) {
    if (node.type === "definition")
      definitions.set(node.identifier.toUpperCase(), node.url);
    node.children?.forEach(definitionsIn);
  }
  definitionsIn(tree);
  function visit(node) {
    if (
      ["code", "inlineCode", "html", "math", "inlineMath"].includes(node.type)
    )
      return;
    if (node.type === "image")
      refs.set(node.url, { url: node.url, wiki: false });
    if (node.type === "imageReference") {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url) refs.set(url, { url, wiki: false });
    }
    if (node.type === "link")
      fileRefs.set(node.url, { url: node.url, wiki: false });
    if (node.type === "linkReference") {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url) fileRefs.set(url, { url, wiki: false });
    }
    if (node.type === "text") {
      for (const match of node.value.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
        const url = match[1].split("|")[0];
        if (match[0].startsWith("!"))
          refs.set("lithos-asset:" + encodeURIComponent(url), { url, wiki: true });
        // Non-image wiki embeds are rendered as links by remarkWikiLinks.
        if (!match[0].startsWith("!") || !imageTypes[path.extname(url.split(/[?#]/)[0]).toLowerCase()])
          fileRefs.set("lithos-link:" + encodeURIComponent(url), { url, wiki: true });
      }
    }
    if (!["link", "linkReference"].includes(node.type))
      node.children?.forEach(visit);
    else node.children?.filter((child) => child.type !== "text").forEach(visit);
  }
  visit(tree);
  const paths = (await vault.listFiles())
    .filter((file) => file.type === "file")
    .map((file) => file.path);
  const images = Object.create(null),
    downloads = Object.create(null),
    assets = Object.create(null),
    warnings = [];
  let total = Buffer.byteLength(content);
  function resolve(ref) {
    let target = ref.url.split(/[?#]/)[0];
    let resolved = null;
    if (ref.wiki) resolved = resolveLink(target, source, paths);
    else {
      try {
        target = decodeURIComponent(target);
      } catch {
        /* invalid reference */
      }
      if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) {
        const candidate = path.posix.normalize(
          target.startsWith("/")
            ? target.slice(1)
            : path.posix.join(path.posix.dirname(source), target),
        );
        resolved = paths.find(
          (file) => file.toLowerCase() === candidate.toLowerCase(),
        );
      }
    }
    return resolved;
  }
  for (const [key, ref] of refs) {
    if (/^https?:\/\//i.test(ref.url)) continue;
    const resolved = resolve(ref);
    if (!resolved || !imageTypes[path.extname(resolved).toLowerCase()]) {
      if (includeFiles && fileRefs.has("lithos-link:" + encodeURIComponent(ref.url))) continue;
      warnings.push(`포함하지 못한 첨부: ${ref.url}`);
      continue;
    }
    const id = createHash("sha256").update(resolved).digest("hex").slice(0, 32);
    if (!assets[id]) {
      const absolute = await vault.safePath(resolved);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
        throw new Error("공유 이미지 한 개의 최대 크기는 8 MB입니다.");
      const bytes = await fs.readFile(absolute);
      total += bytes.length;
      if (total > 20 * 1024 * 1024)
        throw new Error(
          "노트와 공유 이미지의 합계는 20 MB 이하로 줄여 주세요.",
        );
      assets[id] = {
        type: imageTypes[path.extname(resolved).toLowerCase()],
        data: bytes.toString("base64"),
      };
    }
    images[key] = id;
  }
  const copied = new Map();
  if (includeFiles) for (const [key, ref] of fileRefs) {
    if (!ref.url || ref.url.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref.url)) continue;
    const explicitDownload = new URLSearchParams(ref.url.split("#")[0].split("?")[1]).get("download") === "1";
    const resolved = resolve(ref);
    let target;
    try { target = decodeURIComponent(ref.url.split(/[?#]/)[0]); }
    catch { target = ref.url.split(/[?#]/)[0]; }
    const extension = path.extname(resolved || target).toLowerCase();
    // Ordinary note links stay private. A deliberately inserted download link
    // may include the original Markdown/Canvas file, without following its links.
    if (!explicitDownload && (!extension || [".md", ".canvas"].includes(extension))) continue;
    if (!resolved) {
      warnings.push(`포함하지 못한 다운로드 파일: ${ref.url}`);
      continue;
    }
    if (!downloadDirectory) throw new Error("다운로드 저장 위치가 없습니다.");
    if (!copied.has(resolved)) {
      const absolute = await vault.safePath(resolved);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_DOWNLOAD)
        throw new Error("다운로드 파일 한 개의 최대 크기는 250 MB입니다.");
      if (total + stat.size > MAX_TOTAL)
        throw new Error("노트와 첨부 파일의 합계는 500 MB 이하로 줄여 주세요.");
      const id = createHash("sha256").update(resolved).digest("hex").slice(0, 32);
      const destination = path.join(downloadDirectory, id);
      let size = 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          total += chunk.length;
          if (size > MAX_DOWNLOAD || total > MAX_TOTAL)
            callback(new Error("다운로드 파일은 한 개 250 MB, 전체 500 MB 이하로 줄여 주세요."));
          else callback(null, chunk);
        },
      });
      try {
        await pipeline(createReadStream(absolute), meter,
          createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      } catch (error) {
        await fs.rm(destination, { force: true });
        throw error;
      }
      copied.set(resolved, { id, name: path.basename(resolved), size });
    }
    downloads[key] = copied.get(resolved);
  }
  return {
    title: path.basename(source, path.extname(source)),
    content,
    images,
    downloads,
    assets,
    warnings: [...new Set(warnings)],
  };
}
module.exports = { snapshot };
