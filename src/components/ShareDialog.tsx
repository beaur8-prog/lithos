import { useEffect, useRef, useState } from "react";
import {
  X,
  Link2,
  Copy,
  ExternalLink,
  RefreshCw,
  Globe,
  ShieldCheck,
} from "lucide-react";
import { api } from "../bridge";
import { titleOf } from "../model";
import type { ShareState } from "../types";

export default function ShareDialog({
  path,
  flush,
  onClose,
}: {
  path: string;
  flush: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [state, setState] = useState<ShareState>();
  const [days, setDays] = useState(30);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [fileOptions, setFileOptions] = useState<Record<string, boolean>>({});
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [all, setAll] = useState(!path);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, [busy]);
  useEffect(() => {
    let disposed = false;
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    async function refresh() {
      try {
        const next = await api.getShares!();
        if (!disposed) setState(next);
      } catch (e: any) {
        if (!disposed) setError(e.message);
      }
    }
    void refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      clearInterval(interval);
      previous?.focus();
    };
  }, []);
  const run = async (
    label: string,
    operation: () => Promise<ShareState>,
    message: string,
  ) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      setState(await operation());
      setNotice(message);
    } catch (e: any) {
      setError(
        e.message?.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ) || "요청을 완료하지 못했습니다.",
      );
    } finally {
      setBusy("");
    }
  };
  const current =
    state?.shares.filter(
      (share) =>
        share.source === path && share.vaultId === state.currentVaultId,
    ) || [];
  const shares = all ? state?.shares || [] : current;
  const existing = current.some((share) => !share.expired);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="노트 공유"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const controls = [
              ...dialog.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled),select,input,a[href]",
              ),
            ];
            const first = controls[0],
              last = controls[controls.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-header">
          <h2>
            <Link2 size={20} /> 노트 공유
          </h2>
          <button
            className="icon-button"
            aria-label="공유 창 닫기"
            disabled={!!busy}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        <p className="modal-description">
          링크를 아는 사람은 PC와 휴대폰에서 읽을 수 있습니다.
          <br />이 Mac의 Lithos가 실행 중일 때 문서를 제공합니다.
        </p>
        <div className="share-connection">
          <Globe size={18} />
          <div>
            <strong>
              {state?.origin
                ? "외부 인터넷 연결됨"
                : busy || state?.connecting
                  ? "외부 연결 준비 중…"
                  : "Mac에서 직접 공유"}
            </strong>
            <small>
              Cloudflare가 HTTPS 연결을 중계합니다. 문서는 Mac에 저장됩니다.
            </small>
          </div>
          {state && !state.origin && state.shares.some((s) => !s.expired) && (
            <button
              className="secondary"
              disabled={!!busy || state.connecting}
              onClick={() =>
                void run(
                  "연결 중…",
                  () => api.connectShares!(),
                  "새 주소가 준비되었습니다. 링크를 다시 복사해 주세요.",
                )
              }
            >
              다시 연결
            </button>
          )}
        </div>
        <p className="share-address-note">
          임시 주소는 앱 재시작·재연결 후 바뀔 수 있습니다. 그때는 새 링크를
          복사해 주세요. 공유 중에는 Mac의 자동 잠자기를 방지합니다.
        </p>
        {path && (
          <section className="share-create">
            <div>
              <span className="small-label">현재 노트</span>
              <h3>{titleOf(path)}</h3>
              <p>
                <ShieldCheck size={14} /> 본문·이미지와 선택한 첨부 파일만 공유
              </p>
            </div>
            {!existing && (
              <div className="share-create-actions">
                <label className="share-file-option">
                  <input type="checkbox" checked={includeFiles} disabled={!!busy}
                    onChange={(e) => setIncludeFiles(e.target.checked)} />
                  연결된 첨부 파일 다운로드 허용
                </label>
                <label>
                  링크 만료
                  <select
                    value={days}
                    disabled={!!busy}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={7}>7일 후</option>
                    <option value={30}>30일 후</option>
                    <option value={90}>90일 후</option>
                    <option value={0}>만료 없음</option>
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={!!busy || !state}
                  onClick={() =>
                    void run(
                      "공유 링크 만드는 중…",
                      async () => {
                        await flush();
                        return api.createShare!(path, days, includeFiles);
                      },
                      "공유 링크를 만들었습니다.",
                    )
                  }
                >
                  <Link2 size={15} /> 공유 링크 만들기
                </button>
              </div>
            )}
          </section>
        )}
        <div className="share-list-heading">
          <strong>{all ? "모든 공유 링크" : "이 노트의 공유 링크"}</strong>
          {path && (
            <button className="text-button" onClick={() => setAll(!all)}>
              {all ? "현재 노트만" : "모든 공유 관리"}
            </button>
          )}
        </div>
        {(error || state?.error) && (
          <p className="share-error" role="alert">
            {error || state?.error}
          </p>
        )}
        {(busy || notice) && (
          <p className="share-notice" role="status">
            {busy || notice}
          </p>
        )}
        {!state && !error && (
          <p className="modal-description" role="status">
            공유 상태를 불러오는 중…
          </p>
        )}
        {state && !shares.length && (
          <p className="share-empty">아직 공유 중인 링크가 없습니다.</p>
        )}
        <div className="share-list">
          {shares.map((share) => (
            <section className="share-card" key={share.token}>
              <div className="share-card-title">
                <strong>{share.title}</strong>
                <span>
                  {share.expired
                    ? "만료됨"
                    : share.expiresAt
                      ? `${new Date(share.expiresAt).toLocaleDateString("ko-KR")}까지`
                      : "만료 없음"}
                </span>
              </div>
              <small>
                {new Date(share.updatedAt).toLocaleString("ko-KR")} 갱신
                {share.vaultId !== state!.currentVaultId
                  ? " · 다른 보관함"
                  : ""}
              </small>
              <label className="share-file-option">
                <input type="checkbox"
                  checked={fileOptions[share.token] ?? Boolean(share.includeFiles)}
                  disabled={!!busy || share.expired || share.vaultId !== state!.currentVaultId}
                  onChange={(e) => setFileOptions((previous) => ({ ...previous, [share.token]: e.target.checked }))} />
                연결된 첨부 파일 다운로드 허용
              </label>
              <small>
                현재 다운로드 파일 {share.downloadCount || 0}개 · 변경 후 공유본 갱신
              </small>
              {!share.expired && share.vaultId === state!.currentVaultId && <div className="share-edit-settings">
                <strong>{share.editingEnabled ? "공동 편집 켜짐" : "브라우저 공동 편집"}</strong>
                <p>링크와 4자리 암호를 아는 사람이 원본을 함께 편집합니다. 켜져 있는 동안 Mac 앱에서는 읽기만 가능합니다.</p>
                <div className="share-edit-controls">
                  <input type="password" inputMode="numeric" maxLength={4} autoComplete="off"
                    aria-label={`${share.title} 4자리 편집 암호`} placeholder={share.editingEnabled ? "새 암호 4자리" : "암호 4자리"}
                    value={pins[share.token] || ""} disabled={!!busy}
                    onChange={(e) => setPins((p) => ({ ...p, [share.token]: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
                  <button className="secondary" disabled={!!busy || (pins[share.token] || "").length !== 4}
                    onClick={() => void run("공동 편집 설정 중…", async () => {
                      await flush();
                      const next = await api.configureShareEditing!(share.token, true, pins[share.token]);
                      setPins((p) => ({ ...p, [share.token]: "" }));
                      return next;
                    }, share.editingEnabled ? "암호를 변경했습니다. 참여자는 새 암호로 다시 접속해야 합니다." : "공동 편집을 켰습니다. 암호는 참여자에게 별도로 알려 주세요.")}>{share.editingEnabled ? "암호 변경" : "공동 편집 켜기"}</button>
                  {share.editingEnabled && <button className="secondary" disabled={!!busy}
                    onClick={() => void run("공동 편집 끄는 중…", () => api.configureShareEditing!(share.token, false), "공동 편집을 껐습니다. 저장된 내용은 그대로 남습니다.")}>편집 끄기</button>}
                </div>
                <small>잘못된 암호 5회 입력 시 1분간 잠깁니다. 암호 변경 시 접속 중인 편집이 종료됩니다.</small>
              </div>}
              {share.url && (
                <input
                  className="share-url"
                  aria-label={`${share.title} 공유 링크`}
                  value={share.url}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
              )}
              <div className="share-card-actions">
                <button
                  className="secondary"
                  disabled={!share.url || !!busy}
                  onClick={() => {
                    setError("");
                    void api
                      .copyShareLink!(share.token)
                      .then(() => setNotice("링크를 복사했습니다."))
                      .catch(() =>
                        setError(
                          "복사하지 못했습니다. 링크를 선택한 뒤 ⌘C를 눌러 주세요.",
                        ),
                      );
                  }}
                >
                  <Copy size={14} /> 링크 복사
                </button>
                <button
                  className="secondary"
                  disabled={!share.url || !!busy}
                  onClick={() =>
                    void api
                      .openExternal(share.url)
                      .catch((e) => setError(e.message))
                  }
                >
                  <ExternalLink size={14} /> 열기
                </button>
                <button
                  className="secondary"
                  disabled={
                    !!busy ||
                    share.expired ||
                    share.editingEnabled ||
                    share.vaultId !== state!.currentVaultId
                  }
                  onClick={() =>
                    void run(
                      "공유본 갱신 중…",
                      async () => {
                        await flush();
                        return api.updateShare!(share.token, fileOptions[share.token] ?? Boolean(share.includeFiles));
                      },
                      "현재 저장된 내용으로 갱신했습니다.",
                    )
                  }
                >
                  <RefreshCw size={14} /> 공유본 갱신
                </button>
                <button
                  className="share-revoke"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "공유 중지 중…",
                      () => api.revokeShare!(share.token),
                      "공유를 중지했습니다. 기존 링크로 더 이상 열 수 없습니다.",
                    )
                  }
                >
                  공유 중지
                </button>
              </div>
              {!!share.warnings.length && (
                <details className="share-warnings">
                  <summary>
                    포함하지 못한 첨부 {share.warnings.length}개
                  </summary>
                  {share.warnings.map((warning, i) => (
                    <p key={i}>{warning}</p>
                  ))}
                </details>
              )}
            </section>
          ))}
        </div>
        <p className="share-footnote">
          파일은 노트의 클립 버튼으로 추가하세요. 파일 하나 250 MB, 전체 500 MB까지
          지원합니다. 일반 노트 링크는 제외하며, 다운로드 링크로 첨부한 노트 파일은
          속성을 포함한 원본 파일 전체를 제공합니다.
        </p>
        <p className="share-footnote">
          공동 편집 내용은 자동 저장됩니다. 새 첨부 파일을 공유하려면 편집을 끄고 ‘공유본 갱신’ 후 다시 켜세요. 읽기 전용 공유본은 원본을 삭제해도
          공유본은 남으며, ‘공유 중지’로 해제할 수 있습니다.
        </p>
      </div>
    </div>
  );
}
