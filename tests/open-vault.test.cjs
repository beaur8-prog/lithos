"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { openVault } = require("../electron/open-vault.cjs");

test("a responding vault opens without closing its watcher", async () => {
  let closed = false;
  const vault = { async init() { return this; }, close() { closed = true; } };
  assert.equal(await openVault(vault, 100), vault);
  assert.equal(closed, false);
});

test("a stalled folder times out and a late watcher is closed", async () => {
  let resolveInit;
  let closes = 0;
  const vault = {
    init() { return new Promise((resolve) => { resolveInit = resolve; }); },
    close() { closes++; },
  };
  await assert.rejects(openVault(vault, 5), /폴더가 응답하지 않습니다/);
  assert.equal(closes, 1);
  resolveInit(vault);
  await Promise.resolve();
  assert.equal(closes, 2);
});

test("a failed vault closes and keeps the original failure", async () => {
  let closed = false;
  const error = new Error("permission denied");
  const vault = { async init() { throw error; }, close() { closed = true; } };
  await assert.rejects(openVault(vault, 100), (caught) => caught === error);
  assert.equal(closed, true);
});
