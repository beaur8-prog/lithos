# Obsidian 관찰 및 재구현 범위

관찰일: 2026-10-16 (Asia/Seoul)
대상: `/Applications/Obsidian.app`, 버전 1.14.4.

## 근거

### 앱 패키지 (정적 관찰)

Electron 앱 번들의 `Resources/app.asar`(약 469KB), `Resources/obsidian.asar`(약 26MB)를 확인했습니다. ASAR 헤더를 실행 없이 읽어 앱 리소스의 파일 구성을 확인했습니다. 본체에는 `package.json`, `main.js`, `app.js`, `app.css`, `index.html`, `worker.js`, `sim.js` 등이 있습니다. 파일명은 실행 경로나 특정 기능의 구현을 입증하지 않습니다.

REA 분석 대상 SHA-256: `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`.

- 원본 Evidence: `ev_3f2ebd8642e6c00f0dc06cf81f156a4212930a05f9812666ff9173b9838e2dea`
- 요약 Evidence: `ev_8a71a82be917e9b751c4f0a2882666ed1815aeaf303c03658c5d190dd8b26009`
- 로컬 전체 Evidence: `analysis/evidence.json` (Git 제외)

REA JavaScript 분석은 macOS Swift SDK/컴파일러의 `~Copyable` 관련 오류로 시작 단계에서 중단됐습니다. 구문 분석 완료 파일은 0개이며 코드 호출 그래프·실행 경로·내부 저장 알고리즘을 확인한 것으로 간주하지 않습니다. 별도의 app.asar 시도에서는 unpacked native binding의 무결성 불일치가 보고돼 분석을 계속하지 않았습니다. 결과를 숨기거나 완전한 역공학으로 주장하지 않습니다.

### 실행 중인 앱 화면 (직접 관찰)

CUA 접근성 트리와 스크린샷으로 다음을 확인했습니다.

- 왼쪽 리본과 파일·검색·북마크 탐색, 하단 보관함 선택
- 노트 제목, 편집/보기 전환, 탭과 분할된 그래프 뷰
- 위키 링크를 포함한 환영 노트, 백링크 수, 단어·문자 수 표시
- ⌘P 명령 팔레트 및 ⌘O·⌘N·⌘G 등 표시된 단축키
- 개요·태그·백링크·일일 노트·새 캔버스 등 메뉴 항목

메뉴 항목 존재는 해당 기능의 모든 동작을 관찰했다는 뜻이 아닙니다. 사용자 원본 보관함에는 시험 노트를 만들지 않았습니다.

### 공개 규격

- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/): nodes, edges, 파일/텍스트 카드, 위치·크기·색상·연결 라벨을 독립적으로 구현하는 근거.
- [JSON Canvas](https://jsoncanvas.org/): `.canvas`의 공개 파일 포맷과 호환 목적.
- [Obsidian Live Preview 설명](https://help.obsidian.md/Live%2Bpreview%2Bupdate): 커서 주변 원본 Markdown과 나머지 줄의 서식 표시라는 상호작용 참고.

## 구현 결정과 미확인 영역

| 질문 | 상태 | 결과 |
| --- | --- | --- |
| 앱 구조/대상 식별 | 확인 | Electron/ASAR, 설치 버전과 본체 해시 |
| 노트 화면·탭·명령 UX | 부분 확인 | 실제 화면과 접근성 트리 관찰 |
| 원본의 내부 파일 저장 로직 | 미확인 | 독립적인 atomic-write/직렬화 방식 설계 |
| 원본 Canvas 내부 알고리즘 | 미확인 | 공개 JSON Canvas 규격으로 독립 구현 |
| 파일 기반 노트와 링크 동작 재구현 | 구현·시험 | 자체 테스트 및 CUA 검증 |
| 모든 Obsidian 기능의 동등성 | 미확인/범위 밖 | 플러그인/Sync/Publish/Bases 등 미구현 |

Lithos는 관찰한 핵심 작업 흐름을 재구현한 독립 앱입니다. 원본 소스·아이콘·CSS를 복사하지 않았으며, 화면 스타일과 내부 알고리즘은 별도로 작성했습니다.
