"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

class ShareTunnel {
  constructor(directory, onChange = () => {}) {
    this.directory = directory;
    this.onChange = onChange;
    this.origin = "";
    this.error = "";
    this.child = null;
    this.pending = null;
  }
  async start(port) {
    if (this.origin) return this.origin;
    if (this.pending) return this.pending;
    this.pending = this.connect(port).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async connect(port) {
    this.error = "";
    const binaries = [
      "/opt/homebrew/bin/cloudflared",
      "/usr/local/bin/cloudflared",
    ];
    let binary;
    for (const candidate of binaries) {
      try {
        await fs.access(candidate, 1);
        binary = candidate;
        break;
      } catch {}
    }
    if (!binary)
      throw new Error(
        "Cloudflare 연결 도구가 없습니다. 터미널에서 brew install cloudflared를 실행해 주세요.",
      );
    // An explicit isolated config prevents existing user tunnel settings being used.
    const config = path.join(this.directory, "tunnel.yml");
    await fs.writeFile(config, "no-autoupdate: true\n", { mode: 0o600 });
    return new Promise((resolve, reject) => {
      let settled = false,
        candidateOrigin = "",
        registered = false,
        buffer = "";
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith("TUNNEL_")) delete env[key];
      const child = spawn(
        binary,
        [
          "tunnel",
          "--config",
          config,
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${port}`,
          "--protocol",
          "http2",
          "--metrics",
          "127.0.0.1:0",
        ],
        { stdio: ["ignore", "ignore", "pipe"], env },
      );
      this.child = child;
      const fail = (message) => {
        if (this.child !== child) return;
        this.origin = "";
        this.error = message;
        this.onChange();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(message));
        }
      };
      const timeout = setTimeout(() => {
        fail(
          "외부 연결 시간이 초과되었습니다. 인터넷 연결을 확인하고 다시 연결해 주세요.",
        );
        child.kill();
      }, 45000);
      child.stderr.on("data", (bytes) => {
        buffer = (buffer + bytes.toString()).slice(-16000);
        candidateOrigin ||=
          buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] || "";
        registered ||= buffer.includes("Registered tunnel connection");
        if (candidateOrigin && registered && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.origin = candidateOrigin;
          this.error = "";
          this.onChange();
          resolve(candidateOrigin);
        }
      });
      child.on("error", () =>
        fail("외부 연결 도구를 실행하지 못했습니다. 다시 연결해 주세요."),
      );
      child.on("exit", () => {
        clearTimeout(timeout);
        fail(
          "외부 연결이 종료되었습니다. 다시 연결하면 새 주소가 만들어집니다.",
        );
        if (this.child === child) this.child = null;
      });
    });
  }
  stop() {
    const child = this.child;
    this.origin = "";
    child?.kill();
  }
}
module.exports = { ShareTunnel };
