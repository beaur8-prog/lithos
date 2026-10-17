import type { VaultAPI, VaultState } from "./types";
import { demoNotes, basename } from "./model";
function demoAPI(): VaultAPI {
  let files: Record<string, string>;
  try {
    files = JSON.parse(localStorage.getItem("lithos-demo") || "null") || {
      ...demoNotes,
    };
  } catch {
    files = { ...demoNotes };
  }
  let ws = {};
  const persist = () =>
    localStorage.setItem("lithos-demo", JSON.stringify(files));
  const state = (): VaultState => ({
    root: "browser-demo",
    name: "Lithos Vault",
    files: [
      ...new Set(
        Object.keys(files).flatMap((p) =>
          p
            .split("/")
            .slice(0, -1)
            .map((_, i) =>
              p
                .split("/")
                .slice(0, i + 1)
                .join("/"),
            ),
        ),
      ),
    ]
      .map((p) => ({ path: p, name: basename(p), type: "folder" as const }))
      .concat(
        Object.keys(files).map((p) => ({
          path: p,
          name: basename(p),
          type: "file" as any,
        })),
      ),
  });
  return {
    getState: async () => state(),
    readFile: async (p) => files[p] ?? "",
    writeFile: async (p, c) => {
      files[p] = c;
      persist();
    },
    createFile: async (p, c = "") => {
      if (p in files) throw Error("같은 이름의 파일이 있습니다.");
      files[p] = c;
      persist();
      return state();
    },
    createFolder: async () => {
      throw Error("폴더 관리는 데스크톱 앱에서 사용할 수 있습니다.");
    },
    rename: async (a, b) => {
      if (b in files) throw Error("같은 이름의 파일이 있습니다.");
      files[b] = files[a];
      delete files[a];
      persist();
      return state();
    },
    trash: async (p) => {
      delete files[p];
      persist();
      return state();
    },
    chooseVault: async () => {
      throw Error("보관함 열기는 데스크톱 앱에서 사용할 수 있습니다.");
    },
    createVault: async () => {
      throw Error("보관함 생성은 데스크톱 앱에서 사용할 수 있습니다.");
    },
    assetUrl: async () => "",
    onChanged: () => () => {},
    getWorkspace: async () => ws,
    saveWorkspace: async (x) => {
      ws = x;
    },
    openExternal: async (u) => {
      window.open(u, "_blank", "noopener");
    },
    importFiles: async () => [],
  };
}
export const api = window.vault || demoAPI();
