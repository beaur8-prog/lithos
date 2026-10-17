export type VaultFile = {
  path: string;
  name: string;
  type: "file" | "folder";
  extension?: string;
  mtime?: number;
};
export type VaultState = {
  editingPaths?: string[];
  root: string;
  name: string;
  files: VaultFile[];
  recent?: string[];
};
export type Workspace = {
  tabs?: string[];
  active?: string;
  theme?: "dark" | "light";
  bookmarks?: string[];
  mode?: "live" | "source" | "preview" | "split";
  fontSize?: number;
  rightPanel?: boolean;
};
export type VaultAPI = {
  getShares?(): Promise<ShareState>;
  copyShareLink?(token: string): Promise<boolean>;
  connectShares?(): Promise<ShareState>;
  createShare?(path: string, days: number, includeFiles?: boolean): Promise<ShareState>;
  updateShare?(token: string, includeFiles?: boolean): Promise<ShareState>;
  configureShareEditing?(token: string, enabled: boolean, pin?: string): Promise<ShareState>;
  revokeShare?(token: string): Promise<ShareState>;
  onCommand?(cb: (event: { action: string }) => void): () => void;
  onBeforeClose?(cb: () => void): () => void;
  confirmClose?(): void;
  cancelClose?(): void;
  getState(): Promise<VaultState>;
  chooseVault(): Promise<VaultState | null>;
  createVault(): Promise<VaultState | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
  createFile(path: string, content?: string): Promise<VaultState>;
  createFolder(path: string): Promise<VaultState>;
  rename(a: string, b: string): Promise<VaultState>;
  trash(path: string): Promise<VaultState>;
  assetUrl(path: string): Promise<string>;
  onChanged(cb: (e: any) => void): () => void;
  getWorkspace(): Promise<Workspace>;
  saveWorkspace(value: Workspace): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  importFiles(): Promise<string[]>;
  getTrash?(): Promise<any[]>;
  restoreTrash?(id: string): Promise<VaultState>;
};
export type SharedDocument = {
  editingEnabled?: boolean;
  includeFiles?: boolean;
  downloadCount?: number;
  token: string;
  title: string;
  source: string;
  vaultId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  expired: boolean;
  warnings: string[];
  url: string;
};
export type ShareState = {
  origin: string;
  connecting: boolean;
  error: string;
  currentVaultId: string;
  shares: SharedDocument[];
};
declare global {
  interface Window {
    vault?: VaultAPI;
  }
}
