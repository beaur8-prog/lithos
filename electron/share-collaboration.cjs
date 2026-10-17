"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { Text, ChangeSet } = require("@codemirror/state");
const { rebaseUpdates } = require("@codemirror/collab");
const { Vault } = require("./vault.cjs");
const derive = promisify(scrypt);
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const split = (raw) => {
  const prefix = raw.match(frontmatter)?.[0] || "";
  return { prefix, content: raw.slice(prefix.length).replace(/\r\n?/g, "\n") };
};

class ShareCollaboration {
  constructor(server, getVault = () => null) {
    this.server = server;
    this.getVault = getVault;
    this.vaults = new Map();
    this.rooms = new Map();
    this.sessions = new Map();
    this.attempts = new Map();
  }
  lockedPaths(vaultId) {
    return [...this.server.records.values()]
      .filter((r) => r.vaultId === vaultId && r.editing && this.server.active(r))
      .map((r) => r.source);
  }
  reset(token) {
    this.rooms.delete(token);
    this.attempts.delete(token);
    for (const [key, session] of this.sessions)
      if (session.token === token) this.sessions.delete(key);
  }
  async vaultFor(record) {
    const current = this.getVault();
    if (current?.id === record.vaultId) return current;
    if (!this.vaults.has(record.vaultId)) {
      if (!record.editing?.root) throw fail(409, "원본 보관함을 열 수 없습니다. 소유자에게 알려 주세요.");
      const vault = await new Vault(record.editing.root, { watch: false }).init();
      if (vault.id !== record.vaultId) throw fail(409, "원본 보관함의 위치가 변경되었습니다.");
      this.vaults.set(record.vaultId, vault);
    }
    return this.vaults.get(record.vaultId);
  }
  configure(vault, token, enabled, pin) {
    return this.server.serialize(async () => {
      const record = this.server.records.get(token);
      if (!record || record.vaultId !== vault.id || !this.server.active(record))
        throw new Error("이 공유본의 원래 보관함을 열어 주세요. 만료된 링크는 설정할 수 없습니다.");
      if (typeof enabled !== "boolean") throw new Error("편집 설정을 확인해 주세요.");
      if (!enabled) {
        const next = { ...record };
        delete next.editing;
        await this.server.persist(next);
        this.reset(token);
        return this.server.state();
      }
      if (typeof pin !== "string" || !/^\d{4}$/.test(pin))
        throw new Error("편집 암호는 숫자 4자리로 입력해 주세요.");
      if ([...this.server.records.values()].some((r) => r.token !== token && r.vaultId === vault.id && r.source === record.source && r.editing && this.server.active(r)))
        throw new Error("이 노트의 다른 링크에서 공동 편집이 켜져 있습니다. 먼저 해당 링크의 편집을 꺼 주세요.");
      const salt = randomBytes(16).toString("hex");
      const pinHash = (await derive(pin, salt, 32)).toString("hex");
      await vault.serialize(async () => {
        const raw = await vault.readFile(record.source);
        const { content } = split(raw);
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("공동 편집 노트는 1 MB 이하로 줄여 주세요.");
        const backup = path.join(this.server.directory, "edit-backups");
        await fs.mkdir(backup, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(backup, `${token}-${Date.now()}-${randomBytes(4).toString("hex")}.md`), raw, { mode: 0o600, flag: "wx" });
        await this.server.persist({ ...record, content, updatedAt: Date.now(),
          editing: { salt, pinHash, root: vault.root, sourceHash: hash(raw) } });
      });
      this.vaults.set(vault.id, vault);
      this.reset(token);
      return this.server.state();
    });
  }
  async room(record) {
    if (this.rooms.has(record.token)) return this.rooms.get(record.token);
    const vault = await this.vaultFor(record);
    const raw = await vault.readFile(record.source).catch(() => { throw fail(409, "원본 파일을 열 수 없습니다. 소유자에게 알려 주세요."); });
    if (hash(raw) !== record.editing.sourceHash)
      throw fail(409, "원본이 다른 앱에서 변경되었습니다. 소유자가 공동 편집을 다시 설정해야 합니다.");
    const { prefix, content } = split(raw);
    const room = { epoch: randomBytes(16).toString("hex"), raw, prefix,
      doc: Text.of(content.split("\n")), history: [], baseVersion: 0, version: 0, bytes: 0 };
    this.rooms.set(record.token, room);
    return room;
  }
  prune() {
    for (const [key, session] of this.sessions)
      if (session.expires < Date.now() || !this.server.records.get(session.token)?.editing)
        this.sessions.delete(key);
  }
  async authenticate(record, input) {
    this.prune();
    const attempt = this.attempts.get(record.token) || { failed: 0, until: 0 };
    if (attempt.until > Date.now()) throw fail(429, "암호를 여러 번 틀렸습니다. 1분 후 다시 시도해 주세요.");
    if (attempt.until) { attempt.failed = 0; attempt.until = 0; }
    const validFormat = typeof input.pin === "string" && /^\d{4}$/.test(input.pin);
    const candidate = validFormat ? await derive(input.pin, record.editing.salt, 32) : Buffer.alloc(32);
    if (!validFormat || !timingSafeEqual(candidate, Buffer.from(record.editing.pinHash, "hex"))) {
      attempt.failed++;
      if (attempt.failed >= 5) attempt.until = Date.now() + 60000;
      this.attempts.set(record.token, attempt);
      throw fail(401, "편집 암호가 맞지 않습니다.");
    }
    this.attempts.delete(record.token);
    if (this.sessions.size >= 256 || [...this.sessions.values()].filter((s) => s.token === record.token).length >= 32)
      throw fail(429, "참여 가능한 편집 인원이 찼습니다. 잠시 후 다시 시도해 주세요.");
    const room = await this.room(record);
    const key = randomBytes(32).toString("hex");
    const session = { token: record.token, clientID: randomBytes(16).toString("hex"),
      name: String(input.name || "참여자").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24) || "참여자",
      expires: Date.now() + 8 * 3600000, seen: Date.now() };
    this.sessions.set(key, session);
    return { session: key, clientID: session.clientID, content: room.doc.toString(), epoch: room.epoch, version: room.version };
  }
  session(record, req) {
    this.prune();
    const key = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "")?.[1];
    const session = this.sessions.get(key);
    if (!session || session.token !== record.token) throw fail(401, "편집 인증이 만료되었습니다. 입력 내용을 보관한 뒤 다시 참여해 주세요.");
    session.seen = Date.now();
    return { key, session };
  }
  async synchronize(record, session, input, writing) {
    const room = await this.room(record);
    const version = Number(input.version);
    if (input.epoch !== room.epoch || !Number.isSafeInteger(version) || version < room.baseVersion || version > room.version)
      throw fail(409, "문서의 편집 세션이 변경되었습니다. 입력 내용을 보관한 뒤 다시 참여해 주세요.");
    if (writing) {
      if (!Array.isArray(input.updates) || input.updates.length < 1 || input.updates.length > 100)
        throw fail(400, "변경 내용을 확인할 수 없습니다.");
      let incoming;
      try {
        incoming = input.updates.map((update) => ({ changes: ChangeSet.fromJSON(update.changes), clientID: session.clientID }));
        incoming = rebaseUpdates(incoming, room.history.slice(version - room.baseVersion));
      } catch { throw fail(400, "문서 변경 형식이 올바르지 않습니다."); }
      if (incoming.length) {
        let nextDoc = room.doc;
        try { for (const update of incoming) nextDoc = update.changes.apply(nextDoc); }
        catch { throw fail(400, "문서 버전과 변경 내용이 맞지 않습니다."); }
        const content = nextDoc.toString();
        if (Buffer.byteLength(room.prefix + content) > 1024 * 1024)
          throw fail(413, "노트 크기는 1 MB까지 지원합니다. 입력 내용을 보관한 뒤 줄여 주세요.");
        // New frontmatter would become hidden metadata after reopening the source.
        if (!room.prefix && frontmatter.test(content))
          throw fail(400, "공유 편집에서는 문서 맨 앞에 YAML 속성을 추가할 수 없습니다.");
        const vault = await this.vaultFor(record);
        await vault.serialize(async () => {
          const current = await vault.readFile(record.source).catch(() => null);
          if (current !== room.raw) throw fail(409, "원본이 다른 앱에서 변경되었습니다. 입력 내용을 보관하고 소유자에게 알려 주세요.");
          const raw = room.prefix + content;
          await vault.atomicWrite(record.source, raw);
          try {
            // Keep the owner's approved attachment snapshot; web edits never load local files.
            await this.server.persist({ ...record, content, updatedAt: Date.now(), editing: { ...record.editing, sourceHash: hash(raw) } });
          } catch (error) {
            await vault.atomicWrite(record.source, room.raw);
            throw error;
          }
          room.raw = raw;
          vault.emit("changed", { type: "write", paths: [record.source] });
        });
        room.doc = nextDoc;
        for (const update of incoming) {
          update.bytes = JSON.stringify(update.changes.toJSON()).length;
          room.bytes += update.bytes;
          room.history.push(update);
        }
        room.version += incoming.length;
      }
    }
    const response = {
      epoch: room.epoch, version: room.version,
      updates: room.history.slice(version - room.baseVersion).map((u) => ({ changes: u.changes.toJSON(), clientID: u.clientID })),
      participants: [...this.sessions.values()].filter((s) => s.token === record.token && s.seen > Date.now() - 20000).map((s) => ({ id: s.clientID, name: s.name })),
    };
    while (room.history.length > 4096 || room.bytes > 8 * 1024 * 1024) {
      room.bytes -= room.history.shift().bytes;
      room.baseVersion++;
    }
    return response;
  }
  async handle(req, res, token, action, send) {
    const json = (status, value) => send(status, JSON.stringify(value), "application/json; charset=utf-8");
    try {
      const origin = req.headers.origin;
      if ((origin && ![this.server.tunnel.origin, `http://127.0.0.1:${this.server.port}`].includes(origin)) || req.headers["sec-fetch-site"] === "cross-site")
        throw fail(403, "이 페이지에서 편집 요청을 허용하지 않습니다.");
      if (!["GET", "POST"].includes(req.method) || (action !== "updates" && req.method !== "POST")) throw fail(405, "허용하지 않는 요청입니다.");
      let input = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
      if (req.method === "POST") {
        if (!(req.headers["content-type"] || "").startsWith("application/json")) throw fail(415, "JSON 요청이 필요합니다.");
        let length = 0;
        const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) throw fail(413, "변경 내용이 너무 큽니다.");
          chunks.push(chunk);
        }
        try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw fail(400, "요청 형식을 확인해 주세요."); }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "요청 형식을 확인해 주세요.");
      }
      const result = await this.server.serialize(async () => {
        const record = this.server.records.get(token);
        if (!record || !this.server.active(record)) throw fail(404, "공유가 중지되었거나 만료되었습니다.");
        if (!record.editing) throw fail(403, "소유자가 공동 편집을 껐습니다.");
        if (action === "auth") return this.authenticate(record, input);
        const { key, session } = this.session(record, req);
        if (action === "leave") { this.sessions.delete(key); return { ok: true }; }
        return this.synchronize(record, session, input, req.method === "POST");
      });
      return json(200, result);
    } catch (error) {
      return json(error.status || 503, { error: error.status ? error.message : "Mac에 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도합니다." });
    }
  }
}
module.exports = { ShareCollaboration };
