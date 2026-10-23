"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { snapshot } = require("./share-snapshot.cjs");
const { ShareCollaboration } = require("./share-collaboration.cjs");
const { ShareTunnel } = require("./share-tunnel.cjs");
const tokenPattern = /^[a-f0-9]{48}$/;
const setPattern = /^[a-f0-9]{32}$/;
const contentTypes = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function sharePage(template, title) {
  const escaped = String(title || "공유 노트").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  // Link preview crawlers read the initial HTML without running the reader's JS.
  // A callback preserves literal dollar signs in note titles during replacement.
  return template.replace(/<title>[\s\S]*?<\/title>/i, () => [
    `<title>${escaped} · Lithos</title>`,
    `<meta property="og:title" content="${escaped}" />`,
    '<meta property="og:type" content="article" />',
    '<meta property="og:site_name" content="Lithos" />',
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${escaped}" />`,
  ].join("\n    "));
}

class ShareServer {
  constructor({ directory, webRoot, tunnel, getVault, onChange = () => {} }) {
    this.directory = directory;
    this.webRoot = webRoot;
    this.onChange = onChange;
    this.tunnel = tunnel || new ShareTunnel(directory, onChange);
    this.records = new Map();
    this.collaboration = new ShareCollaboration(this, getVault);
    this.queue = Promise.resolve();
    this.port = 0;
    this.server = null;
    this.starting = null;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{48}\.json$/.test(file)) continue;
      const record = JSON.parse(
        await fs.readFile(path.join(this.directory, file), "utf8"),
      );
      if (record.token === file.slice(0, -5))
        this.records.set(record.token, record);
    }
    const retained = new Set([...this.records.values()].map((r) => r.downloadSet));
    const downloadsRoot = path.join(this.directory, "downloads");
    await fs.mkdir(downloadsRoot, { recursive: true, mode: 0o700 });
    for (const set of await fs.readdir(downloadsRoot))
      if (setPattern.test(set) && !retained.has(set)) await this.removeDownloads(set);
    return this;
  }
  active(record) {
    return !record.expiresAt || record.expiresAt > Date.now();
  }
  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async listen() {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end("Unavailable");
        });
      });
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.maxHeadersCount = 50;
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async connect() {
    await this.listen();
    await this.tunnel.start(this.port);
    return this.state();
  }
  state() {
    return {
      origin: this.tunnel.origin,
      connecting: Boolean(this.tunnel.pending),
      error: this.tunnel.error,
      shares: [...this.records.values()]
        .map((r) => ({
          token: r.token,
          title: r.title,
          source: r.source,
          vaultId: r.vaultId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          expiresAt: r.expiresAt,
          expired: !this.active(r),
          warnings: r.warnings,
          includeFiles: Boolean(r.includeFiles),
          editingEnabled: Boolean(r.editing),
          downloadCount: new Set(Object.values(r.downloads || {}).map((d) => d.id)).size,
          url:
            this.tunnel.origin && this.active(r)
              ? `${this.tunnel.origin}/s/${r.token}`
              : "",
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }
  async persist(record) {
    const target = path.join(this.directory, record.token + ".json");
    await fs.writeFile(target + ".tmp", JSON.stringify(record), {
      mode: 0o600,
    });
    await fs.rename(target + ".tmp", target);
    this.records.set(record.token, record);
    this.onChange();
  }
  async removeDownloads(set) {
    if (setPattern.test(set || ""))
      await fs.rm(path.join(this.directory, "downloads", set), { recursive: true, force: true });
  }
  async prepare(vault, source, includeFiles) {
    if (typeof includeFiles !== "boolean") throw new Error("첨부 파일 포함 여부를 확인해 주세요.");
    const downloadSet = includeFiles ? randomBytes(16).toString("hex") : null;
    const downloadDirectory = downloadSet && path.join(this.directory, "downloads", downloadSet);
    if (downloadDirectory) await fs.mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
    try {
      return { ...await snapshot(vault, source, { includeFiles, downloadDirectory }), includeFiles, downloadSet };
    } catch (error) {
      await this.removeDownloads(downloadSet);
      throw error;
    }
  }
  create(vault, source, days = 30, includeFiles = false) {
    return this.serialize(async () => {
      if (![0, 7, 30, 90].includes(days))
        throw new Error("지원하지 않는 만료일입니다.");
      const prepared = await this.prepare(vault, source, includeFiles);
      try {
      await this.connect();
      const now = Date.now();
      const record = {
        ...prepared,
        token: randomBytes(24).toString("hex"),
        vaultId: vault.id,
        source,
        createdAt: now,
        updatedAt: now,
        expiresAt: days ? now + days * 86400000 : null,
      };
      await this.persist(record);
      return this.state();
      } catch (error) {
        await this.removeDownloads(prepared.downloadSet);
        throw error;
      }
    });
  }
  update(vault, token, includeFiles) {
    return this.serialize(async () => {
      const previous = this.records.get(token);
      if (!previous || previous.vaultId !== vault.id)
        throw new Error("이 공유본의 원래 보관함을 열어 주세요.");
      if (!this.active(previous))
        throw new Error("만료된 공유본입니다. 새 링크를 만들어 주세요.");
      const prepared = await this.prepare(vault, previous.source, includeFiles ?? Boolean(previous.includeFiles));
      try {
        if (previous.editing) throw new Error("공동 편집을 끈 뒤 공유본을 갱신해 주세요. 새 첨부 파일을 반영한 후 다시 켤 수 있습니다.");
        await this.persist({ ...previous, ...prepared, updatedAt: Date.now() });
      } catch (error) {
        await this.removeDownloads(prepared.downloadSet);
        throw error;
      }
      // A failed cleanup may leave an unreferenced directory; init removes it.
      await this.removeDownloads(previous.downloadSet).catch(() => {});
      return this.state();
    });
  }
  revoke(token) {
    return this.serialize(async () => {
      if (!tokenPattern.test(token))
        throw new Error("올바르지 않은 공유 링크입니다.");
      const previous = this.records.get(token);
      await fs.rm(path.join(this.directory, token + ".json"), { force: true });
      this.records.delete(token);
      this.collaboration.reset(token);
      await this.removeDownloads(previous?.downloadSet).catch(() => {});
      this.onChange();
      return this.state();
    });
  }
  async handle(req, res) {
    const headers = {
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    };
    const send = (code, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { ...headers, "Content-Type": type });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const route = new URL(req.url, "http://localhost").pathname;
    const edit = /^\/s\/([a-f0-9]{48})\/edit\/(auth|updates|leave)$/.exec(route);
    if (edit) return this.collaboration.handle(req, res, edit[1], edit[2], send);
    if (!["GET", "HEAD"].includes(req.method)) return send(405, "Read only");
    if (route === "/robots.txt")
      return send(200, "User-agent: *\nDisallow: /\n");
    const staticFile = /^\/static\/assets\/([a-zA-Z0-9_.-]+)$/.exec(route);
    if (staticFile && contentTypes[path.extname(staticFile[1])]) {
      try {
        return send(
          200,
          await fs.readFile(path.join(this.webRoot, "assets", staticFile[1])),
          contentTypes[path.extname(staticFile[1])],
        );
      } catch {
        return send(404, "Unavailable");
      }
    }
    const match =
      /^\/s\/([a-f0-9]{48})(?:\/(data|asset\/([a-f0-9]{32})|download\/([a-f0-9]{32})))?\/?$/.exec(route);
    const record = match && this.records.get(match[1]);
    if (!record || !this.active(record))
      return send(404, "이 공유 링크는 만료되었거나 공유가 중지되었습니다.");
    if (match[2] === "data") {
      const { title, content, images, downloads = {}, updatedAt, expiresAt } = record;
      return send(
        200,
        JSON.stringify({ title, content, images, downloads, updatedAt, expiresAt, editingEnabled: Boolean(record.editing) }),
        "application/json; charset=utf-8",
      );
    }
    if (match[4]) {
      const file = Object.values(record.downloads || {}).find((d) => d.id === match[4]);
      if (!file || !setPattern.test(record.downloadSet || "")) return send(404, "Unavailable");
      let handle;
      try {
        handle = await fs.open(path.join(this.directory, "downloads", record.downloadSet, file.id), "r");
      } catch { return send(404, "Unavailable"); }
      try {
        const { size } = await handle.stat();
        const filename = file.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_");
        const fallback = filename.replace(/[^a-zA-Z0-9._ -]/g, "_") || "download";
        headers["Content-Disposition"] = `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
        headers["Accept-Ranges"] = "bytes";
        let start = 0, end = size - 1, status = 200;
        if (req.headers.range && req.method === "GET") {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (range && (range[1] || range[2])) {
            if (!range[1]) start = Math.max(0, size - Number(range[2]));
            else {
              start = Number(range[1]);
              if (range[2]) end = Math.min(end, Number(range[2]));
            }
          }
          if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
            headers["Content-Range"] = `bytes */${size}`;
            return send(416, "Range not satisfiable");
          }
          status = 206;
          headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        }
        res.writeHead(status, { ...headers, "Content-Type": "application/octet-stream", "Content-Length": Math.max(0, end - start + 1) });
        if (req.method === "HEAD" || !size) return res.end();
        await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
      } finally { await handle.close(); }
      return;
    }
    if (match[3]) {
      const asset = record.assets[match[3]];
      if (!asset) return send(404, "Unavailable");
      headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
      return send(200, Buffer.from(asset.data, "base64"), asset.type);
    }
    return send(
      200,
      sharePage(await fs.readFile(path.join(this.webRoot, "share.html"), "utf8"), record.title),
      "text/html; charset=utf-8",
    );
  }
  async close() {
    this.tunnel.stop();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}
module.exports = { ShareServer };
