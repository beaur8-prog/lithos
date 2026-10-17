"use strict";

// Cloud File Providers can leave an OS directory request pending indefinitely.
// Reject that selection while safely closing any watcher created by a late result.
async function openVault(vault, timeoutMs = 15000) {
  let timedOut = false;
  let timer;
  try {
    return await Promise.race([
      vault.init().then((ready) => {
        if (timedOut) ready.close();
        return ready;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("폴더가 응답하지 않습니다. 동기화 상태와 접근 권한을 확인한 뒤 다시 열어 주세요."));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    vault.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { openVault };
