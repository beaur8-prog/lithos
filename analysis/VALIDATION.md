# Lithos 검증 기록

검증일: 2026-10-16 (Asia/Seoul). Apple Silicon macOS에서 실행했습니다.

이 기록에 언급된 `artifacts/` 캡처는 로컬 검증 자료이며 Git 저장소에 포함하지 않습니다. 실제 공유 주소와 개인 경로는 공개 기록에서 제외했습니다.

## 자동 검증

- `npm test`: 23개 통과 (파일 저장소 14개, Markdown/링크 모델 6개, 폴더 열기 수명 관리 3개).
- `npm run build`: TypeScript 검사 및 Vite 프로덕션 번들 생성 성공. 큰 번들 경고가 있으며 코드 분할 최적화는 남아 있습니다.
- `npm audit --omit=dev`: 실행 의존성 취약점 0개. 개발 도구까지 포함한 감사에는 electron-builder의 전이 의존성 관련 moderate 항목 8개가 남았습니다.

파일 저장소 테스트는 연속 저장 직렬화, 원자적 교체, 경로 이탈 및 심볼릭 링크 거부, 위키/Markdown/Canvas 참조 갱신, 이름 변경 실패 시 되돌리기, 휴지통 복원 충돌 방지, 첨부 파일 이름 충돌, 작업 공간 저장, 외부 파일 변경 감지를 다룹니다.

모델 테스트는 Markdown과 위키 링크의 서로 다른 상대 경로 해석, 중복 이름, 인코딩된 파일명과 제목 이동, 지원하지 않는 URL, 코드/메타데이터의 링크 제외, 정확한 원본 위치의 체크박스 수정 등을 다룹니다.

폴더 열기 테스트는 정상 초기화, 응답 없는 폴더의 제한 시간 처리, 늦게 초기화된 감시기 정리, 원래 오류 보존을 확인합니다.

Canvas는 별도 개발 중 핸들러 시뮬레이션으로 8개 시나리오를 확인했습니다. 이동/실행 취소, 취소된 포인터, 외부 문서 A→B→A 변경 등을 포함하며, 이는 `npm test`의 23개와 별도입니다.

## 실제 앱 화면과 디스크 검증

CUA로 개발용 데스크톱 앱을 직접 조작하고 실제 보관함 파일을 대조했습니다.

| 작업 | 확인 결과 |
| --- | --- |
| 한국어 노트 생성과 편집 | 하위 폴더의 `.md` 생성, 한글 본문 저장 |
| 자동 저장과 읽기 모드 | 변경 내용이 디스크에 기록됨 |
| 읽기 모드 체크박스 | 해당 원본 항목이 `[x]`로 변경됨 |
| 내부 링크와 백링크 | 링크로 대상 노트 이동, 새 노트에서 온 백링크 표시 |
| 전체 검색 | 입력한 본문으로 결과를 찾고 노트 열기 |
| 그래프 | 연결된 노트 표시, 노드 클릭으로 노트 이동 |
| 노트 이름 변경 | 탐색기·탭·파일 경로 반영 |
| 삭제와 복원 | 휴지통에서 복원, 복원 후 휴지통 항목 제거 |
| Canvas 카드와 연결 | 텍스트 카드 생성·편집·포트 연결 후 `.canvas`의 nodes/edges 확인 |
| 종료 | ⌘Q로 프로세스 종료 확인 |

시험 파일은 직접 만든 예제 보관함에만 생성했습니다. 시험 종료 후 해당 파일은 복원 가능한 `.lithos-trash`로 옮겼고, 시험 Canvas 카드·연결은 원래 예제 상태로 정리했습니다. 원본 Obsidian 보관함에 시험 데이터를 만들지 않았습니다.

## 설치본 검증 및 시작 문제 수정

- `/Applications/Lithos.app`의 `file:///Applications/Lithos.app/Contents/Resources/app.asar/dist/index.html` 화면을 확인했습니다. 개발 서버를 사용하지 않는 설치본입니다.
- 앱을 일반 실행해 보관함·탭을 복원했습니다. 설치본에서 Canvas 카드를 드래그한 뒤 디스크 좌표가 `(0, 0)`에서 `(45, -44)`로 바뀐 것을 확인했습니다.
- 실행 취소 직후 ⌘Q로 종료했고, 디스크에 원래 좌표 `(0, 0)`가 저장됐습니다. 다시 일반 실행했을 때 활성 Canvas 탭과 카드·연결이 복원됐습니다.
- `codesign --verify --deep --strict /Applications/Lithos.app`를 통과했습니다. ad-hoc 로컬 서명이며 Developer ID 배포 서명·공증은 아닙니다.
- 재설치용 ZIP: `release/Lithos-mac-arm64.zip`.

초기 패키징에서는 파일 동기화 제공자가 붙인 Finder 메타데이터가 서명을 방해했습니다. 패키징 위치를 `~/Library/Caches/LithosBuild`로 변경해 해결했습니다. 또 문서 폴더 안의 예제 보관함을 읽는 OS 요청이 끝나지 않는 현상을 재현했습니다. 정확한 제공자 내부 원인은 확인하지 않았습니다. 직접 만든 예제 보관함만 `~/Lithos Vault`로 옮겼고 기본 위치도 변경했습니다. 앱 창을 파일 로딩 전에 표시하고, 보관함 초기화는 15초 안에 응답하지 않으면 실패 처리해 다른 보관함으로 복구할 수 있도록 했습니다. 기존 보관함을 자동으로 옮기지는 않습니다.

## 검증 한계

- Obsidian 전체 기능과 동등하다는 검증이 아닙니다. [관찰 보고서](OBSERVATIONS.md)에 정적 분석 실패와 실제 확인 범위를 구분했습니다.
- 대형 보관함 성능, 서로 다른 프로그램의 동시 편집 충돌 병합, 모든 Markdown 문법 조합은 확인하지 않았습니다.
- Canvas의 모든 포인터·터치·트랙패드 조합을 실제 기기로 시험하지 않았습니다.
- 로컬 Apple Silicon 빌드입니다. 다른 Mac 및 배포용 서명·공증 경로는 검증하지 않았습니다.

## 2026-10-17 커서 가독성 개선

본문 커서를 3px로 늘리고 다크/라이트 테마별 대비 색을 지정했습니다. 깜빡임을 끄고 편집 중인 줄을 은은하게 표시합니다. 기본 편집기 테마가 커서 색을 덮어쓰지 않도록 CSS 우선순위를 조정했습니다. `npm run package`와 설치본 서명 검증을 통과했고, 설치된 앱의 실시간 편집 화면에서 빈 줄의 밝은 커서와 현재 줄 표시를 직접 확인했습니다. 시각 스타일 변경으로 새 자동 테스트는 추가하지 않았습니다.
# Mac-hosted document sharing — 2026-10-17

- Added a loopback-only HTTP reader and per-document snapshots under the app's private `shares` folder. Cloudflare Quick Tunnel provides external HTTPS. No document was deployed to Sites; the unused local cloud scaffold was removed.
- Installed official Homebrew `cloudflared` 2026.10.1. No global service or router settings were changed. Lithos starts/stops its own tunnel process.
- `npm test`: 29/29 passing, including six sharing tests for private-route isolation, selected assets, traversal/symlink rejection, immutable snapshots, explicit updates, persistence, revocation, expiry, ownership/size checks, and connection failure.
- `npm run package`: TypeScript, both production bundles, Apple Silicon packaging and ad-hoc signing passed. `codesign --verify --deep --strict /Applications/Lithos.app` passed after installation.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- External HTTPS requests returned 200 for the test document, JSON and an embedded image. Response data excludes vault IDs, local source paths and unrelated note content.
- Browser UI verified Korean text, table, disabled task checkboxes, KaTeX math and SVG image. At a 390px viewport, document client width and scroll width were both 375px; no horizontal page overflow. No browser warning/error logs.
- Installed app UI verified create, native clipboard copy, explicit snapshot update, persistent share recovery after restart and revocation. The second snapshot appeared at the same URL after clicking update. After revocation, external document/data requests returned 404 with `Cache-Control: no-store`.
- Native clipboard IPC is used because renderer clipboard permission is intentionally denied. Modal focus stays inside the dialog during operations, and workspace keyboard/menu commands do not switch the vault while the dialog is open.
- `pmset -g assertions` confirmed Lithos holds an idle-sleep assertion while an active share exists and releases it after the last share is revoked.
- Tests used synthetic documents only. The temporary vault document was moved to Lithos's recoverable trash, and test share links were revoked. Existing user notes were not shared or altered.
- Limitations: Markdown notes only (no Canvas share), manually refreshed snapshots, app/network must stay available, Quick Tunnel domain changes after restarting/reconnecting. Mobile layout was checked in a browser viewport; no physical phone or separate PC was controlled.


## 2026-10-17 공유 화면의 Mermaid 직접 렌더링

- `src/share/MermaidDiagram.tsx`와 Markdown `pre` 처리기로 Mermaid 코드 블록을 SVG로 직접 렌더링합니다. 엔진은 필요한 문서에서만 불러오며 같은 Mac의 정적 자산으로 제공합니다. 외부 렌더링 API를 호출하지 않습니다.
- 확대/화면 맞춤, 키보드로 접근 가능한 가로 스크롤, 원문 펼치기, 문법 오류·빈 원문·20,000자 제한 안내를 추가했습니다. 다른 코드 블록은 그대로 표시합니다.
- strict 모드, 연결선 제한 500개, 보안 설정을 바꾸는 지시문 차단, 클릭 콜백 미설치, 기존 CSP 유지. 오류 후 임시 DOM을 정리합니다.
- TypeScript와 두 프로덕션 빌드 통과. 테스트 30/30 통과. 새 테스트는 Mermaid 라벨의 이미지 문법이 비공개 파일을 공유하지 않으며 코드 원문과 CSP가 보존되는지 검사합니다. `npm audit --omit=dev`: 취약점 0개.
- 실제 공유 서버와 동일한 CSP를 사용하는 loopback 시험 페이지에서 한국어 흐름도, 실제 Lithos 구조도, 시퀀스, 여러 블록, 오류 시 원문, 일반 코드 유지, 악성 HTML/클릭 지시문 차단, 길이 제한을 확인했습니다. 렌더링된 SVG 4개, 위험한 SVG 노드 0개, 잔여 측정 DOM 0개. 브라우저 오류/경고 없음.
- 390px 휴대폰 너비에서 문서 clientWidth/scrollWidth 모두 375px. 확대했을 때 그림 영역은 924px까지 가로 스크롤되며 문서 전체 너비는 유지됩니다. 실제 휴대폰 검증은 아닙니다.
- Apple Silicon 패키징과 로컬 코드 서명 검증 통과. 사용자가 새 링크로 전환을 승인한 뒤 앱을 정상 종료하고 `/Applications/Lithos.app`을 교체했습니다. 설치본 서명 검증과 재실행 성공. 이전 설치본과 문서 백업은 `~/Library/Caches/LithosBuild/backups/20261017-093350/`에 보존했습니다.
- 정리 노트의 별도 구조도 이미지 2개를 Mermaid 코드 블록 2개로 바꾸고 중복 원문 부록을 제거했습니다. 기존 다른 이미지 3개는 유지했습니다.
- 공유본을 갱신한 뒤 새 외부 HTTPS 주소에서 실제 SVG 2개와 확대 버튼을 확인했습니다. 공개 본문은 로컬 노트와 일치하며 기존 토큰·만료일은 유지됐습니다. 공개 브라우저 오류/경고 없음.
- 증거 화면: `artifacts/mermaid-native-render-preview.png`, `artifacts/mermaid-live-share.png`. 이번 변경은 공유 브라우저에 적용하며 데스크톱 편집기의 Mermaid 미리보기는 포함하지 않습니다.

## 2026-10-17 파일 다운로드 공유

- 첨부 파일 가져오기는 이미지를 표시하고, 다른 파일은 보관함 루트 기준 Markdown 다운로드 링크로 삽입한다. 한글·공백·괄호·대괄호·# 파일명을 실제 Markdown 파서와 브라우저에서 확인했다.
- 공유 창에 다운로드 허용 옵션과 현재 포함된 파일 수를 추가했다. 기존 공유본의 기본값은 꺼짐이며, 생성/갱신 시 명시한 옵션만 적용한다. 일반 노트 링크는 제외하고 `?download=1`로 지정한 원본 노트 파일만 별도 다운로드에 포함한다.
- 파일은 공유본별 비공개 디렉터리에 복사한다. 갱신 실패 시 이전 공유본 유지 및 임시 파일 정리, 재시작 복원, 갱신 후 이전 파일 정리, 공유 중지 시 정리를 구현했다.
- 다운로드는 application/octet-stream, Content-Disposition attachment, UTF-8 파일명, nosniff, sandbox, GET/HEAD/단일 Range를 지원한다. 파일 하나 250 MB, 전체 500 MB를 실제 복사 중에도 검사한다.
- 자동 테스트 34개 통과. 파일 바이트 일치, 한글 파일명, Range/HEAD/잘못된 범위, 만료·중지·다른 토큰 접근 차단, 소스 삭제 후 스냅샷 유지, 파일 과대 시 갱신 원자성, 다운로드 해제, 연결 실패 정리를 확인했다.
- 프로덕션 빌드와 macOS 패키징·코드 서명 검증 통과. 설치 ZIP: release/Lithos-mac-arm64.zip.
- 로컬 실제 ShareServer와 프로덕션 공유 번들에서 CUA로 다운로드 링크를 클릭해 파일을 저장했다. 원본과 SHA-256 일치(4a3a869b873c14e254419c5a59e794c0b3cde505f881032628063826df4a4e87). Mermaid 함께 표시 정상. 휴대폰 390px 뷰포트에서 clientWidth/scrollWidth 모두 375px이며 넘침 없음. 뷰포트 복원 완료.
- 사용자가 재시작을 미뤄 달라고 요청하여 설치 앱 적용과 외부 HTTPS 최종 검증은 보류했다. 기존 설치본과 실행 중인 공유는 유지했다.

## 2026-10-17 4자리 암호와 브라우저 공동 편집 — 적용 보류

- 사용자가 재시작을 미뤄 달라고 요청했다. `/Applications/Lithos.app`과 실행 중인 Cloudflare 터널은 교체·재시작하지 않았다. 파일 다운로드와 공동 편집을 함께 포함한 `release/Lithos-mac-arm64.zip`만 준비했다.
- 공유 창에서 숫자 4자리 암호로 편집을 켜거나 끄고 암호를 변경할 수 있다. 기본은 읽기 전용이며 읽기에는 암호를 요구하지 않는다. PIN은 솔트+scrypt 해시, 웹 인증은 난수 bearer 세션으로 분리했다. 암호 실패 5회/1분 제한, Origin 및 JSON 검사, 세션·본문·히스토리 크기 제한, 만료·중지·암호 변경 시 세션 폐기를 적용했다.
- `@codemirror/collab`의 변경분 병합을 중앙 서버에 구현했다. 브라우저는 약 1초 간격으로 갱신을 받으며, 원본 Markdown과 공유 본문을 함께 저장한다. 원래 YAML은 보존하고 웹 편집에서 숨긴다. 재전송은 중복 반영하지 않는다.
- 원본 보관함의 큐에서 이전 내용 확인과 원자적 저장을 처리한다. 다른 앱이 원본을 바꿨다면 덮어쓰지 않고 편집을 중단한다. 공유 기록 저장 실패 시 원본을 되돌린다. 편집 설정 때 원본을 비공개 `shares/edit-backups`에 보관한다.
- 웹 편집은 기존에 소유자가 공유한 이미지·다운로드 목록만 유지한다. 새 경로를 적어도 임의의 로컬 파일을 읽거나 공개하지 않는다. 새 첨부는 소유자가 공동 편집을 끄고 추가·갱신해야 한다.
- 공동 편집 중인 노트는 데스크톱에서 읽기 전용으로 표시하고, IPC에서도 쓰기·삭제를 차단한다. 해당 보관함의 이름 변경은 링크 재작성 충돌을 피하도록 잠시 제한한다. 소유자도 공유 링크에서 함께 편집한다.
- 자동 테스트 41/41 통과. 2인 충돌 삽입·삭제·재전송, 3인 입력 중 이전 요청 응답 도착과 한글·이모지 수렴, PIN·추측 제한·출처·무인증 요청, 비공개 파일 미노출, 원본 외부 변경, 버전·크기 검증, 만료·중지, 재시작 후 저장 복원, 디스크 저장 실패 시 롤백을 검사했다.
- 실제 ShareServer와 프로덕션 번들을 로컬 테스트 보관함에서 실행했다. CUA 브라우저 두 탭이 서로 다른 이름으로 암호 인증하고, 통신을 일시 차단한 동안 같은 위치에 각각 작성한 문장이 복구 후 두 탭과 원본 파일에 모두 남는 것을 확인했다. Enter 줄바꿈, 저장 상태, 참여자 표시, 미리보기 동작 확인.
- 인증 세션 종료 시 편집을 중단하고 미저장 본문을 보존했다. 다시 참여한 뒤에도 이전 보관본을 내려받을 수 있었으며, 실제 내려받은 Markdown에 미저장 검증 문장이 포함됐다. 시험용 다운로드는 테스트 디렉터리로 옮겼다.
- TypeScript·프로덕션 빌드, Apple Silicon 패키징, 코드 서명 검증 완료. 증거 화면: `artifacts/collaborative-editing-preview.jpg`.
- 한계: Mac 잠금으로 데스크톱 공유 설정의 클릭 검증은 완료하지 못했다. 별도 프로필로 테스트 앱을 실행했으나 사용 중인 설치본에는 적용하지 않았다. 이번 브라우저 viewport override는 실제 폭을 바꾸지 않아 휴대폰 크기 검증으로 계산하지 않았다. 실물 휴대폰, 외부 HTTPS 공동 편집 및 장시간/다인원 부하 검증은 미실시. 설치 후 실제 공유 연결에서 최종 확인이 필요하다.

## 2026-10-17 공동 편집 업데이트 적용

- 사용자 요청에 따라 기존 앱·공유 설정·원본 문서를 백업한 뒤 설치본을 교체하고 재실행했다. 백업: `~/Library/Caches/LithosBuild/backups/20261017-140201-before-collaboration`. 기존 프로세스 종료를 확인한 뒤 서명 검증된 앱을 설치했다.
- 정리 문서의 기존 토큰과 만료일을 유지하며 요청받은 4자리 암호를 설정했다. 암호 원문은 이 검증 기록에 저장하지 않는다.
- 새 공유 링크 발급을 확인했다. 실제 주소와 접근 토큰은 공개 저장소에 기록하지 않는다.
- 외부 HTTPS 본문, 암호 인증, 인증된 동기화 요청 모두 HTTP 200. 공개 본문과 Mac 원본 일치, 기존 이미지 2개와 Mermaid 블록 4개 유지. 브라우저에서도 편집 인증 후 편집 가능한 본문과 “모든 변경 내용 저장됨”을 확인했다. 입력은 변경하지 않았고 원본 SHA-256이 적용 전과 동일하다. 확인 세션을 종료하고 읽기 화면으로 돌렸다.
- 증거 화면: `artifacts/collaborative-editing-live.jpg`. Mac 화면은 여전히 잠겨 있어 네이티브 설정 화면의 클릭 검증은 미실시했으며, 암호 설정은 앱이 종료된 동안 동일한 백엔드 설정 기능으로 적용했다.
