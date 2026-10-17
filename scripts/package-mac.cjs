"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "darwin") {
  throw new Error("The macOS package must be built on a Mac.");
}

// A File Provider can attach FinderInfo while the signer is running inside
// Documents/iCloud. Stage the bundle in an ordinary local cache instead.
const root = path.resolve(__dirname, "..");
const output = path.join(os.homedir(), "Library", "Caches", "LithosBuild");
execFileSync(
  path.join(root, "node_modules", ".bin", "electron-builder"),
  ["--mac", "dir", "--arm64", `--config.directories.output=${output}`],
  { cwd: root, stdio: "inherit" },
);
const bundle = path.join(output, "mac-arm64", "Lithos.app");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "inherit",
});
fs.mkdirSync(path.join(root, "release"), { recursive: true });
const archive = path.join(root, "release", "Lithos-mac-arm64.zip");
execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive], {
  stdio: "inherit",
});
console.log(`Verified app: ${bundle}\nInstall archive: ${archive}`);
