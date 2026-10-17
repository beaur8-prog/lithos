"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");

const posix = path.posix;
const HIDDEN = new Set([".obsidian", ".lithos", ".lithos-trash", ".git"]);

function normalizePath(value, allowRoot = false) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.includes("\\")
  ) {
    throw new Error("A valid vault-relative path is required.");
  }
  if (path.isAbsolute(value) || /^[a-z]:/i.test(value))
    throw new Error("Absolute paths are not allowed.");
  const parts = value.split("/").filter(Boolean);
  if (
    parts.some(
      (part) => part === ".." || part.startsWith(".") || HIDDEN.has(part),
    )
  ) {
    throw new Error("Hidden paths and parent traversal are not allowed.");
  }
  const result = parts.join("/");
  if (!allowRoot && !result)
    throw new Error("The vault root cannot be changed.");
  return result;
}

function within(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function existsError(error) {
  return error && error.code === "ENOENT";
}

function remapPath(value, oldPath, newPath) {
  return value === oldPath
    ? newPath
    : value.startsWith(`${oldPath}/`)
      ? newPath + value.slice(oldPath.length)
      : value;
}

function resolveLink(target, source, paths) {
  if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(target.trim());
  } catch {
    decoded = target.trim();
  }
  const isRelative = /^\.{1,2}\//.test(decoded);
  const fromSource = posix.normalize(
    posix.join(posix.dirname(source), decoded),
  );
  const rootPath = posix.normalize(decoded.replace(/^\//, ""));
  const candidates = isRelative ? [fromSource] : [rootPath, fromSource];
  const exact = new Map(paths.map((file) => [file.toLowerCase(), file]));
  for (const candidate of candidates) {
    for (const expanded of [
      candidate,
      `${candidate}.md`,
      `${candidate}.canvas`,
    ]) {
      if (exact.has(expanded.toLowerCase()))
        return exact.get(expanded.toLowerCase());
    }
  }
  if (isRelative) return null;
  const lower = decoded.toLowerCase().replace(/\.(md|canvas)$/i, "");
  const matches = paths.filter((file) => {
    const key = file.toLowerCase().replace(/\.(md|canvas)$/i, "");
    return key === lower || key.endsWith(`/${lower}`);
  });
  matches.sort((a, b) => {
    const distance = (file) =>
      posix.relative(posix.dirname(source), file).split("/").length;
    return distance(a) - distance(b) || a.localeCompare(b);
  });
  return matches[0] || null;
}

function updatedLinkTarget(
  original,
  resolved,
  source,
  nextSource,
  nextPaths,
  oldPath,
  newPath,
) {
  const nextTarget = remapPath(resolved, oldPath, newPath);
  if (nextTarget === resolved && nextSource === source) return original;
  const relative = /^\.{1,2}\//.test(original);
  // A moved note can invalidate even a formerly unique basename link.
  if (
    !relative &&
    !original.includes("/") &&
    resolveLink(original, nextSource, nextPaths) === nextTarget
  )
    return original;
  const omittedExtension = !posix.extname(original);
  let output;
  if (relative) {
    output = posix.relative(posix.dirname(nextSource), nextTarget);
    if (original.startsWith("./") && !output.startsWith("."))
      output = `./${output}`;
  } else if (!original.includes("/")) {
    const candidate = posix.basename(nextTarget);
    output =
      resolveLink(candidate, nextSource, nextPaths) === nextTarget
        ? candidate
        : nextTarget;
  } else {
    output = (original.startsWith("/") ? "/" : "") + nextTarget;
  }
  if (omittedExtension) output = output.replace(/\.(md|canvas)$/i, "");
  return output;
}

function updatedMarkdownTarget(
  original,
  source,
  paths,
  oldPath,
  newPath,
  angled = false,
) {
  const split = original.search(/[?#]/);
  const target = split < 0 ? original : original.slice(0, split);
  const suffix = split < 0 ? "" : original.slice(split);
  if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return original;
  let decoded = target.replace(/\\([\\()[\]<> ])/g, "$1");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return original;
  }
  const absolute = decoded.startsWith("/");
  const candidate = posix.normalize(
    absolute ? decoded.slice(1) : posix.join(posix.dirname(source), decoded),
  );
  const resolved = [candidate, `${candidate}.md`, `${candidate}.canvas`]
    .map((value) =>
      paths.find((file) => file.toLowerCase() === value.toLowerCase()),
    )
    .find(Boolean);
  if (!resolved) return original;
  const nextSource = remapPath(source, oldPath, newPath);
  const nextTarget = remapPath(resolved, oldPath, newPath);
  if (nextSource === source && nextTarget === resolved) return original;
  let output = absolute
    ? `/${nextTarget}`
    : posix.relative(posix.dirname(nextSource), nextTarget);
  if (decoded.startsWith("./") && !output.startsWith("."))
    output = `./${output}`;
  if (!decoded.toLowerCase().endsWith(posix.extname(resolved).toLowerCase()))
    output = output.replace(/\.(md|canvas)$/i, "");
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  if (/%[a-f\d]{2}/i.test(target))
    output = output.split("/").map(encode).join("/");
  else
    output = output.replace(
      angled ? /[\\#?%<>]/g : /[\\\s#?%<>()[\]]/g,
      encode,
    );
  return output + suffix;
}

function rewriteMarkdownLinks(text, rewriteTarget) {
  const changes = [];
  const readDestination = (start) => {
    let cursor = start;
    while (/[ \t]/.test(text[cursor] || "\n")) cursor++;
    const angled = text[cursor] === "<";
    if (angled) cursor++;
    const targetStart = cursor;
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (char === "\\") {
        cursor++;
        continue;
      }
      if (angled) {
        if (char === ">") break;
      } else {
        if (char === "(") depth++;
        else if (char === ")") {
          if (!depth) break;
          depth--;
        } else if (/\s/.test(char)) break;
      }
    }
    if (depth || (angled && text[cursor] !== ">")) return null;
    return {
      start: targetStart,
      end: cursor,
      next: cursor + (angled ? 1 : 0),
      angled,
    };
  };
  const title =
    "(?:\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\((?:\\\\.|[^)\\\\])*\\))";
  const closing = new RegExp(`^(?:[ \\t]+${title})?[ \\t]*\\)`);
  const links = /!?\[(?:\\.|[^\]\\])*\]\(/g;
  for (let match; (match = links.exec(text));) {
    const destination = readDestination(links.lastIndex);
    if (!destination) continue;
    const tail = closing.exec(text.slice(destination.next));
    if (!tail) continue;
    changes.push(destination);
    links.lastIndex = destination.next + tail[0].length;
  }
  // Reference-style Markdown links share their destination in a definition.
  const definition = /^ {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*/.exec(text);
  if (definition) {
    const destination = readDestination(definition[0].length);
    const ending = new RegExp(`^(?:[ \\t]+${title})?[ \\t]*$`);
    if (destination && ending.test(text.slice(destination.next)))
      changes.push(destination);
  }
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    const replacement = rewriteTarget(
      text.slice(change.start, change.end),
      change.angled,
    );
    text = text.slice(0, change.start) + replacement + text.slice(change.end);
  }
  return text;
}

function rewriteWikiLinks(text, source, paths, oldPath, newPath) {
  const nextSource = remapPath(source, oldPath, newPath);
  const nextPaths = paths.map((file) => remapPath(file, oldPath, newPath));
  let fence = null;
  // Respect fenced/inline code so documentation examples are not renamed.
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\r?\n$/.test(line)) return line;
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = null;
        return line;
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return line;
      const rewrite = (plain) =>
        rewriteMarkdownLinks(
          plain.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inside) => {
            const split = inside.search(/[|#]/);
            const target = split < 0 ? inside : inside.slice(0, split);
            const suffix = split < 0 ? "" : inside.slice(split);
            const resolved = resolveLink(target, source, paths);
            if (!resolved) return whole;
            return `[[${updatedLinkTarget(target, resolved, source, nextSource, nextPaths, oldPath, newPath)}${suffix}]]`;
          }),
          (target, angled) =>
            updatedMarkdownTarget(
              target,
              source,
              paths,
              oldPath,
              newPath,
              angled,
            ),
        );
      const inlineCode = /(`+)[\s\S]*?\1/g;
      let output = "",
        previous = 0;
      for (let match; (match = inlineCode.exec(line));) {
        output += rewrite(line.slice(previous, match.index)) + match[0];
        previous = match.index + match[0].length;
      }
      return output + rewrite(line.slice(previous));
    })
    .join("");
}

class Vault extends EventEmitter {
  constructor(root, options = {}) {
    super();
    this.root = path.resolve(root);
    this.watchEnabled = options.watch !== false;
    this.watcher = null;
    this.timer = null;
    this.poller = null;
    this.polling = false;
    this.lastSnapshot = "";
    this.queue = Promise.resolve();
  }

  async init() {
    const stat = await fsp.stat(this.root);
    if (!stat.isDirectory()) throw new Error("Choose a folder for your vault.");
    this.root = await fsp.realpath(this.root);
    this.id = createHash("sha256").update(this.root).digest("hex").slice(0, 24);
    if (this.watchEnabled) {
      this.lastSnapshot = this.snapshot(await this.listFiles());
      this.startWatching();
    }
    return this;
  }

  async safePath(
    relative,
    { allowRoot = false, allowMissing = false, internal = false } = {},
  ) {
    const rootStat = await fsp.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("The vault folder is no longer available.");
    const normalized = internal ? relative : normalizePath(relative, allowRoot);
    const target = path.resolve(this.root, normalized);
    if (!within(this.root, target))
      throw new Error("The path is outside this vault.");
    const parts = path
      .relative(this.root, target)
      .split(path.sep)
      .filter(Boolean);
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink())
          throw new Error("Symbolic links are not supported inside a vault.");
        if (index < parts.length - 1 && !stat.isDirectory())
          throw new Error("A parent path is not a folder.");
      } catch (error) {
        if (allowMissing && existsError(error)) break;
        throw error;
      }
    }
    return target;
  }

  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async listFiles() {
    const entries = [];
    const visit = async (relative) => {
      const directory = await this.safePath(relative, { allowRoot: true });
      let children;
      try {
        children = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (existsError(error)) return;
        throw error;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
        const filePath = relative ? `${relative}/${child.name}` : child.name;
        let absolute, stat;
        try {
          absolute = await this.safePath(filePath);
          stat = await fsp.lstat(absolute);
        } catch (error) {
          if (existsError(error) || error.message.includes("Symbolic links"))
            continue;
          throw error;
        }
        if (!stat.isFile() && !stat.isDirectory()) continue;
        entries.push({
          path: filePath,
          name: child.name,
          type: stat.isDirectory() ? "folder" : "file",
          extension: stat.isDirectory()
            ? ""
            : posix.extname(child.name).slice(1).toLowerCase(),
          mtime: stat.mtimeMs,
        });
        if (stat.isDirectory()) await visit(filePath);
      }
    };
    await visit("");
    return entries;
  }

  async getState() {
    return {
      root: this.root,
      name: path.basename(this.root),
      files: await this.listFiles(),
      recent: [],
    };
  }

  async readFile(relative) {
    const absolute = await this.safePath(relative);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) throw new Error("This path is not a file.");
    if (stat.size > 32 * 1024 * 1024)
      throw new Error(
        "This file is too large for the text editor (32 MB maximum).",
      );
    return fsp.readFile(absolute, "utf8");
  }

  async atomicWrite(relative, content, internal = false) {
    if (typeof content !== "string")
      throw new Error("File contents must be text.");
    if (Buffer.byteLength(content) > 32 * 1024 * 1024)
      throw new Error("This file exceeds the 32 MB text limit.");
    const absolute = await this.safePath(relative, {
      allowMissing: true,
      internal,
    });
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await this.safePath(relative, { allowMissing: true, internal });
    const temporary = path.join(
      path.dirname(absolute),
      `.lithos-write-${randomUUID()}`,
    );
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.safePath(relative, { allowMissing: true, internal });
      await fsp.rename(temporary, absolute);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
    }
    return { path: relative, mtime: (await fsp.stat(absolute)).mtimeMs };
  }

  writeFile(relative, content) {
    return this.serialize(async () => {
      const result = await this.atomicWrite(normalizePath(relative), content);
      this.emit("changed", { type: "write", paths: [relative] });
      return result;
    });
  }

  createFile(relative, content = "") {
    return this.serialize(async () => {
      const safe = normalizePath(relative);
      if (typeof content !== "string")
        throw new Error("File contents must be text.");
      if (Buffer.byteLength(content) > 32 * 1024 * 1024)
        throw new Error("This file exceeds the 32 MB text limit.");
      const absolute = await this.safePath(safe, { allowMissing: true });
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await this.safePath(safe, { allowMissing: true });
      await fsp.writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
      this.emit("changed", { type: "create", paths: [safe] });
      return this.getState();
    });
  }

  createFolder(relative) {
    return this.serialize(async () => {
      const safe = normalizePath(relative);
      const absolute = await this.safePath(safe, { allowMissing: true });
      await fsp.mkdir(absolute, { recursive: true });
      this.emit("changed", { type: "create", paths: [safe] });
      return this.getState();
    });
  }

  rename(oldRelative, newRelative) {
    return this.serialize(async () => {
      const oldPath = normalizePath(oldRelative);
      const newPath = normalizePath(newRelative);
      if (oldPath === newPath)
        return { ...(await this.getState()), updatedLinks: 0 };
      if (newPath.startsWith(`${oldPath}/`))
        throw new Error("A folder cannot be moved inside itself.");
      const source = await this.safePath(oldPath);
      const destination = await this.safePath(newPath, { allowMissing: true });
      try {
        await fsp.lstat(destination);
        throw new Error("A file or folder already exists at that path.");
      } catch (error) {
        if (!existsError(error)) throw error;
      }
      const files = (await this.listFiles()).filter(
        (file) => file.type === "file",
      );
      const paths = files.map((file) => file.path);
      const updates = [];
      for (const file of files) {
        if (!["md", "canvas"].includes(file.extension)) continue;
        const original = await this.readFile(file.path);
        let content = original;
        if (file.extension === "md")
          content = rewriteWikiLinks(
            original,
            file.path,
            paths,
            oldPath,
            newPath,
          );
        if (file.extension === "canvas") {
          try {
            const canvas = JSON.parse(original);
            let changed = false;
            for (const node of Array.isArray(canvas.nodes)
              ? canvas.nodes
              : []) {
              if (node.type === "file" && typeof node.file === "string") {
                const next = remapPath(node.file, oldPath, newPath);
                if (next !== node.file) {
                  node.file = next;
                  changed = true;
                }
              }
              if (node.type === "text" && typeof node.text === "string") {
                const next = rewriteWikiLinks(
                  node.text,
                  file.path,
                  paths,
                  oldPath,
                  newPath,
                );
                if (next !== node.text) {
                  node.text = next;
                  changed = true;
                }
              }
            }
            if (changed) content = JSON.stringify(canvas, null, 2) + "\n";
          } catch {
            /* A malformed canvas remains untouched. */
          }
        }
        if (content !== original)
          updates.push({
            path: remapPath(file.path, oldPath, newPath),
            original,
            content,
          });
      }
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await this.safePath(newPath, { allowMissing: true });
      await fsp.rename(source, destination);
      const written = [];
      try {
        for (const update of updates) {
          await this.atomicWrite(update.path, update.content);
          written.push(update);
        }
      } catch (error) {
        const errors = [];
        for (const update of written.reverse())
          await this.atomicWrite(update.path, update.original).catch((e) =>
            errors.push(e),
          );
        await fsp.rename(destination, source).catch((e) => errors.push(e));
        if (errors.length)
          throw new Error(
            `Rename failed and could not be fully rolled back: ${error.message}`,
          );
        throw error;
      }
      this.emit("changed", { type: "rename", paths: [oldPath, newPath] });
      return {
        ...(await this.getState()),
        renamed: { oldPath, newPath },
        updatedLinks: updates.length,
      };
    });
  }

  trash(relative) {
    return this.serialize(async () => {
      const safe = normalizePath(relative);
      const absolute = await this.safePath(safe);
      const id = `${Date.now()}-${randomUUID()}`;
      const trashRelative = `.lithos-trash/${id}`;
      const trashDirectory = await this.safePath(trashRelative, {
        internal: true,
        allowMissing: true,
      });
      await fsp.mkdir(trashDirectory, { recursive: true });
      await this.atomicWrite(
        `${trashRelative}/metadata.json`,
        JSON.stringify({ id, path: safe, deletedAt: new Date().toISOString() }),
        true,
      );
      await this.safePath(`${trashRelative}/content`, {
        internal: true,
        allowMissing: true,
      });
      try {
        await fsp.rename(absolute, path.join(trashDirectory, "content"));
      } catch (error) {
        await fsp.rm(trashDirectory, { recursive: true, force: true });
        throw error;
      }
      this.emit("changed", { type: "trash", paths: [safe] });
      return { ...(await this.getState()), trashed: { id, path: safe } };
    });
  }

  async getTrash() {
    const root = await this.safePath(".lithos-trash", {
      internal: true,
      allowMissing: true,
    });
    let entries;
    try {
      entries = await fsp.readdir(root);
    } catch (error) {
      if (existsError(error)) return [];
      throw error;
    }
    const result = [];
    for (const id of entries) {
      if (!/^\d+-[a-f\d-]+$/.test(id)) continue;
      try {
        const metadata = await this.safePath(
          `.lithos-trash/${id}/metadata.json`,
          { internal: true },
        );
        const entry = JSON.parse(await fsp.readFile(metadata, "utf8"));
        normalizePath(entry.path);
        await this.safePath(`.lithos-trash/${id}/content`, { internal: true });
        result.push({ id, path: entry.path, deletedAt: entry.deletedAt });
      } catch {
        /* Ignore incomplete or externally modified trash entries. */
      }
    }
    return result.sort((a, b) => b.id.localeCompare(a.id));
  }

  restoreTrash(id) {
    return this.serialize(async () => {
      if (typeof id !== "string" || !/^\d+-[a-f\d-]+$/.test(id))
        throw new Error("Invalid trash entry.");
      const metadata = await this.safePath(
        `.lithos-trash/${id}/metadata.json`,
        { internal: true },
      );
      const entry = JSON.parse(await fsp.readFile(metadata, "utf8"));
      const safe = normalizePath(entry.path);
      const source = await this.safePath(`.lithos-trash/${id}/content`, {
        internal: true,
      });
      const destination = await this.safePath(safe, { allowMissing: true });
      try {
        await fsp.lstat(destination);
        throw new Error("A file already exists at the original path.");
      } catch (error) {
        if (!existsError(error)) throw error;
      }
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await this.safePath(safe, { allowMissing: true });
      await fsp.rename(source, destination);
      await fsp.rm(path.dirname(source), { recursive: true, force: true });
      this.emit("changed", { type: "restore", paths: [safe] });
      return this.getState();
    });
  }

  async getWorkspace() {
    try {
      const absolute = await this.safePath(".lithos/workspace.json", {
        internal: true,
      });
      return JSON.parse(await fsp.readFile(absolute, "utf8"));
    } catch (error) {
      if (existsError(error) || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  saveWorkspace(workspace) {
    return this.serialize(async () => {
      if (
        !workspace ||
        typeof workspace !== "object" ||
        Array.isArray(workspace)
      )
        throw new Error("Invalid workspace state.");
      const content = JSON.stringify(workspace, null, 2);
      if (Buffer.byteLength(content) > 1024 * 1024)
        throw new Error("Workspace state is too large.");
      await this.atomicWrite(".lithos/workspace.json", content, true);
      return true;
    });
  }

  async assetUrl(relative) {
    await this.safePath(relative);
    return `lithos-asset://${this.id}/${normalizePath(relative).split("/").map(encodeURIComponent).join("/")}`;
  }

  importPaths(sources) {
    return this.serialize(async () => {
      const imported = [];
      for (const source of sources) {
        const stat = await fsp.stat(source);
        if (!stat.isFile()) continue;
        const basename = path.basename(source);
        if (basename.startsWith(".")) continue;
        const extension = path.extname(basename);
        const stem = basename.slice(0, basename.length - extension.length);
        for (let suffix = 0; suffix < 10000; suffix++) {
          const relative = `attachments/${stem}${suffix ? ` ${suffix}` : ""}${extension}`;
          const destination = await this.safePath(relative, {
            allowMissing: true,
          });
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await this.safePath(relative, { allowMissing: true });
          try {
            await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
            imported.push(relative);
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
      }
      if (imported.length)
        this.emit("changed", { type: "import", paths: imported });
      return imported;
    });
  }

  startWatching() {
    try {
      this.watcher = fs.watch(
        this.root,
        { recursive: true },
        (_event, filename) => {
          const relative = filename
            ? filename.toString().split(path.sep).join("/")
            : "";
          if (relative.split("/").some((part) => part.startsWith("."))) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(
            () =>
              this.emit("changed", {
                type: "external",
                paths: relative ? [relative] : [],
              }),
            160,
          );
        },
      );
      this.watcher.on("error", (error) =>
        this.emit("watch-error", error.message),
      );
    } catch (error) {
      this.emit("watch-error", error.message);
    }
    // FSEvents may miss writes made immediately after subscribing, and some
    // network filesystems do not deliver native watch events at all.
    this.poller = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const snapshot = this.snapshot(await this.listFiles());
        if (snapshot !== this.lastSnapshot) {
          this.lastSnapshot = snapshot;
          this.emit("changed", { type: "external", paths: [] });
        }
      } catch (error) {
        this.emit("watch-error", error.message);
      } finally {
        this.polling = false;
      }
    }, 2000);
    this.poller.unref();
  }

  snapshot(files) {
    return files
      .map((file) => `${file.path}\0${file.type}\0${file.mtime}`)
      .join("\n");
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.poller);
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

async function seedVault(root) {
  const vault = await new Vault(root, { watch: false }).init();
  const welcome =
    "---\ntags: 시작, 가이드\n---\n# 생각을 연결하는 공간\n\n작은 메모 하나에서, 더 큰 생각으로. **Lithos**는 내 컴퓨터에 저장하는 나만의 지식 공간입니다.\n\n> 생각은 연결될 때 더 선명해집니다.\n\n## 나만의 보관함\n\n노트는 평범한 Markdown 파일입니다. 왼쪽의 **+** 버튼으로 새 노트를 만들거나, 이 페이지를 바로 편집해 보세요. 변경 내용은 자동으로 저장됩니다.\n\n## 다음 아이디어로\n\n- [[아이디어 정원]]에서 생각의 씨앗을 모으세요.\n- [[프로젝트/작은 시작]]에서 계획을 구체화하세요.\n- [[연결의 힘]]에서 링크가 만드는 흐름을 살펴보세요.\n- [[생각의 지도.canvas|생각의 지도]]에 아이디어를 펼치세요.\n\n## 오늘 해볼 일\n\n- [x] 나만의 공간 둘러보기\n- [ ] 첫 번째 노트 작성하기\n- [ ] 두 노트를 링크로 연결하기\n- [ ] 캔버스에 아이디어 펼치기\n\n---\n\n`⌘ O` 빠른 전환 · `⌘ P` 명령 팔레트 · `⌘ N` 새 노트\n\n#시작 #생각\n";
  const tutorial =
    "# 연결의 힘\n\n서로 다른 생각이 만날 때 새로운 관점이 생깁니다.\n\n[[아이디어 정원]]에서 발견한 생각을 [[프로젝트/작은 시작]]으로 옮겨 보세요.\n\n## 링크 만들기\n`[[노트 이름]]`으로 다른 노트를 연결합니다.\n\n## 로컬 파일\n노트는 `.md`, 캔버스는 `.canvas` 파일로 보관함에 저장됩니다. 삭제한 파일은 이 보관함의 숨김 폴더 `.lithos-trash`에 보관됩니다.\n\n#생각 #연결\n";
  const ideas =
    "# 아이디어 정원\n\n아직 다 자라지 않은 생각들을 모아 두는 곳.\n\n## 씨앗\n- 매일 한 문장 기록하기\n- 좋아하는 문장과 내 생각 연결하기\n- [[프로젝트/작은 시작|작은 시작]]을 반복하기\n\n## 연결\n[[연결의 힘]]은 꾸준한 기록에서 시작됩니다.\n\n#아이디어 #기록\n";
  const project =
    "# 작은 시작\n\n완벽한 계획보다 오늘의 작은 한 걸음.\n\n## 진행 상황\n- [x] 아이디어 정리\n- [ ] 첫 번째 초안\n- [ ] 다시 읽고 다듬기\n\n| 단계 | 목표 |\n| --- | --- |\n| 발견 | [[아이디어 정원]] |\n| 연결 | [[연결의 힘]] |\n| 실행 | 작은 시도 |\n\n#프로젝트\n";
  const canvas = {
    nodes: [
      {
        id: "a",
        type: "text",
        text: "# 나의 다음 아이디어\n\n어떤 생각을 연결하고 싶나요?",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
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
        fromSide: "right",
        toNode: "b",
        toSide: "left",
        toEnd: "arrow",
        label: "발견",
      },
      {
        id: "ac",
        fromNode: "a",
        fromSide: "right",
        toNode: "c",
        toSide: "left",
        toEnd: "arrow",
        label: "실행",
      },
    ],
  };
  for (const [relative, content] of [
    ["시작하기.md", welcome],
    ["연결의 힘.md", tutorial],
    ["아이디어 정원.md", ideas],
    ["프로젝트/작은 시작.md", project],
    ["생각의 지도.canvas", JSON.stringify(canvas, null, 2) + "\n"],
  ]) {
    await vault.createFile(relative, content);
  }
  vault.close();
}

module.exports = {
  Vault,
  seedVault,
  normalizePath,
  resolveLink,
  rewriteWikiLinks,
};
