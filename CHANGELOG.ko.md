# 변경 기록

[English](CHANGELOG.md) | 한국어

ccrc 의 주요 변경을 여기에 적는다. 형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 를 따르고, 버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) 을 쓴다. `ccrc update` 는 지금 버전과 새 버전 사이의 절을 보여 주고, "Breaking"(이 문서의 "호환성 깨짐") 아래 줄은 따로 보여 준다. `ccrc update` 와 GitHub Release 가 보여 주는 것은 영어판이다.

## [Unreleased]

### 추가

- 기기 설정 "Thinking 펼쳐 보기"(설정 > 알림과 입력 > 대화, 기본 끔). 켜면 대화와 서브에이전트 기록의 Thinking 이 펼쳐진 채로 시작하고, 아직 흘러오는 생각도 글이 오는 대로 보인다. 흘러오는 생각도 이제 다른 칸처럼 눌러 펴고 접는다. 손으로 펴거나 접은 칸은 페이지를 새로 고쳐도 그대로이고, 나머지는 설정을 따른다.

### 변경

- Claude 의 답(아직 흘러오는 답도)이나 내가 보낸 메시지(대기 중인 메시지도)를 길게 누르면 휴대폰의 다른 글처럼 글이 골라지고 확대경과 복사 메뉴가 뜬다. 컴퓨터에서 오른쪽 클릭하면 브라우저의 메뉴가 뜬다. 아직 흘러오는 답은 그 안의 글을 고른 동안 멈춰 있다가 선택을 풀면 따라온다. 답 안의 파일 링크는 길게 눌러도 링크 메뉴가 뜨지 않는다(누르면 전처럼 파일 뷰어가 열린다). 답과 메시지의 동작(Markdown 원문 복사, 대화 내보내기, 여기서 갈래 만들기, 여기서 다시 하기)은 시각 앞의 ⋯ 로만 연다. 메시지 ⋯ 의 44px 누름 범위는 말풍선에 닿지 않는다.

## [0.8.1] - 2026-10-23

### 고침

- iPhone 에서 시트(세션 ⋯ 메뉴, 입력창 칩, 언어 같은 설정)가 어두운 배경만 깔리고 판 안의 스위치만 떠 보였다. 판을 담는 틀이 iOS 의 위쪽 가장자리 검사를 피하려고 자신을 숨겼고, iOS 가 그 안의 판을 그리지 않았다. 이제 틀은 배경의 맨 위 띠 아래에서 시작한다.

## [0.8.0] - 2026-10-23

### 추가

- 휴대폰 앱의 영어 화면. 휴대폰의 첫 번째 선호 언어가 한국어면 한국어로, 아니면 영어로 보인다(기본값 "자동"). 설정 > 언어 / Language 에서 한국어나 English 를 고르면 그것을 따른다. 고른 언어는 휴대폰에 저장되므로 로그인 화면도 따른다. 모든 화면을 옮겼고, Claude 와 Claude Code 가 쓴 글은 쓴 그대로 보인다. 알림은 휴대폰마다 그 언어로 쓴다. 앱은 구독할 때와 언어가 바뀔 때마다 브로커에 언어를 알리고, 브로커는 이를 `~/.config/ccrc/push.json` 의 그 기기 알림 설정에 `lang` 으로 둔다. 휴대폰에서 내보낸 대화도 브로커가 쓰는 머리글과 줄이 같은 언어로 나온다.
- `ccrc setup` 의 `ssh-keygen` 단계가 OpenSSH 8.2 이상인지도 확인한다. `ccrc update` 가 릴리스 서명을 확인하려면 필요하다. git 이 ssh-keygen 에 묻는 것을 똑같이 묻고, `-Y find-principals` 가 없으면 업데이트가 그 확인에서 멈춘다는 경고와 고치는 법을 보여 준다. 어느 쪽이든 setup 은 계속한다. `ccrc update` 도 그 이유로 멈출 때 고치는 법을 알려 준다.
- Claude 가 보내기로 정한 알림. Claude 가 PushNotification 도구를 부르고(예: "시험이 끝나면 알려 줘" 라고 한 뒤) Claude Code 가 그 호출을 실행하면, ccrc 는 휴대폰이 그 세션을 보고 있지 않은 한 바로 휴대폰으로 보내고 그 턴의 "작업을 마쳤습니다" 알림은 생략한다. Claude Code 가 거부했거나 실패한 호출은 아무것도 보내지 않는다. 기기 설정 "Claude가 보내는 알림"(기본 켬)으로 끈다. "도구 이름 표시"를 켜면 알림에 Claude 의 글이 담긴다. Claude Code 자신의 호출은 Remote Control 없이는 아무것도 보내지 않는다. 그래서 PostToolUse 훅이 결과를 바꾼다. ccrc 가 보냈으면 "Mobile push requested." 로, 휴대폰이 그 세션을 보고 있었으면 Claude Code 의 "Not sent — this terminal is active" 로 바꾸고, 그 밖에는 Claude Code 의 원래 답을 둔다. 브로커 세션은 Agent SDK 로 훅을 등록한다. VS Code 세션에서는 이 버전의 래퍼가 훅을 확장의 `initialize` 에 더하고, 브로커가 마지막으로 알려 준 것으로 직접 답한다(hello 의 `caps` 에 `claude_push`). 옛 래퍼로 연 탭도 알림은 보내지만, Claude 는 Claude Code 의 "not sent" 를 읽는다.
- 읽지 않은 세션. 휴대폰이 보고 있지 않을 때 턴이 끝나거나 그 세션의 알림이 나가면 세션은 읽지 않음이 된다. 턴은 브로커 세션이면 모든 턴, VS Code 세션이면 VS Code 의 마지막 메시지 뒤에 휴대폰이 그 세션에 보냈거나 시작했거나 답한 턴이다(그 턴이 시작되기 전 두 시간 안에 그랬을 때). 휴대폰이 열거나 VS Code 에서 그 세션에 메시지를 보낼 때까지 읽지 않음으로 남는다. 목록에 점이 찍히고 "읽지 않음" 필터가 생긴다. 세션 ⋯ 메뉴(더 보기 아래)와 목록에서 길게 누르기로 "읽지 않음으로 표시"(와 "읽음으로 표시")를 할 수 있다. `~/.local/state/ccrc/unread.json`(0600. 세션 id 와 시각, 최대 한 달·500개)에 두므로 브로커를 다시 시작해도 남는다. `ccrc uninstall --purge` 가 지운다.
- 에이전트 지도: 휴대폰에서 연 서브에이전트 기록이 Claude Code 가 쓰는 대로 갱신된다. 열려 있는 동안 브로커는 파일을 지켜보고(커널의 파일 감시. 큰 폴더를 감시하는 편집기가 감시를 다 써 버려 남은 것이 없으면 1초에 두 번 크기를 본다), 더해진 부분만 읽어 새 항목을 WebSocket 으로 보낸다. 휴대폰은 브로커가 파일을 따라가지 못할 때만 2초마다 다시 읽는다. 셸 출력은 브로커가 바뀌는 동안 1초마다, 그대로인 동안 2초마다, 셸이 끝날 때 한 번 더 읽고, 바뀌었을 때만 보낸다.
- "백그라운드로" 단추. 턴이 기다리는 Bash 나 Agent 카드에 나온다(Claude Code 가 그것을 포그라운드에서 돈다고 알린 뒤. 서브에이전트는 2초 뒤). 에이전트 지도에서 포그라운드로 도는 서브에이전트나 셸 카드에도 있다. 누르면 Claude Code 가 그것을 백그라운드로 옮기고, 카드는 거기서 돈다고 알리고, 턴은 계속된다. 브로커 세션은 Agent SDK 의 `backgroundTasks` 를 쓴다. VS Code 세션은 이 릴리스의 래퍼가 있어야 한다(VS Code 창을 다시 불러온다). 이 래퍼는 hello 에서 이를 알리고, Claude Code 가 포그라운드에서 돌리는 호출에 대해서만 `background_tasks` 를 넘긴다. 옛 래퍼면 카드에 단추 대신 새 래퍼를 받는 법이 보인다.
- 변경 사항 시트에 탭이 둘 생겼다. "이 세션"은 세션의 서브에이전트와 워크플로 에이전트가 바꾼 파일(그 기록의 Edit, Write, MultiEdit, NotebookEdit 호출)을 더하고 에이전트의 것으로 표시한다. "git 전체"는 Claude Code 의 diff 패널처럼 폴더의 git 변경을 보여 준다. 브랜치가 기준 브랜치보다 앞서 있으면 갈라진 뒤부터(커밋한 것과 안 한 것을 함께), 아니면 HEAD 부터이고, 세션이 만든 추적되지 않는 파일도 넣는다. 돌고 있는 세션은 자기 Claude Code 에 묻는다(`get_workspace_diff`. 그 세션의 읽기 규칙을 따른다). 프로세스가 없는 세션이거나 Claude Code 가 답하지 못하면 브로커가 읽기 전용 git 명령으로 구한다. 어느 쪽이든 키·토큰 파일과 세션 폴더 밖 파일의 줄은 감추고, 같은 한도(파일 50개, 파일마다 1MB·400줄, 모두 2MB)를 둔다. 줄을 골라 코멘트를 입력창에 넣는 것은 전과 같다.
- 곁질문(입력창의 `/btw`, 또는 ⋯ 메뉴의 곁질문). 턴을 끊거나 대화에 더하지 않고 대화 옆에서 Claude Code 에 묻고, 진행 상황을 보여 준다. 최근 질문과 답 20개는 휴대폰 탭의 sessionStorage 에 남고, 이어지는 질문에 스레드로 함께 간다(최근 것부터 256KB 까지). 질문은 5분이 지나거나 사용자가 취소하면 끝난다. 기다리는 동안 휴대폰 연결이 끊기면 다시 연결된 뒤 다시 기다린다. 브로커가 질문이 어떻게 끝났는지 10분 동안 메모리에 두기 때문이다. 다른 곳에서 앞 질문에 아직 답하는 중이라 거절된 질문은 앞 질문을 포기하고 다시 물을 수 있다. 프로세스가 없는 세션은 사용자가 원하면 먼저 시작한다.
- 갈래를 자기 worktree 에서 돌릴 수 있다. 갈래 시트에 새 세션 화면의 worktree 스위치와 이름 칸이 같은 검사와 함께 생겼다. Claude Code 는 원래 세션 폴더의 HEAD 에서 새 worktree 를 만들고, 시트는 커밋하지 않은 파일 몇 개가 남는지 알려 준다. 이미 worktree 에 있는 세션은 그 worktree 의 HEAD 에서 옆에 새 worktree 를 만들어 갈라진다. 이미 있는 worktree 는 다시 쓰지 않는다. git 밖이거나, 저장소의 하위 폴더에 있는 세션(갈래가 worktree 맨 위에서 돌게 된다)이면 스위치가 꺼진 이유를 알려 준다.
- 메시지에서 갈래를 만들거나 그 메시지로 되돌리면, 메시지의 글과 함께 사진과 문서도 입력창에 다시 넣는다. 대화 기록에서 다시 올린다. 넣지 못한 것(기록에서 사라짐, 휴대폰이 첨부하지 않는 종류, 너무 큼, 입력창 한도 10개를 넘음)은 이름을 알려 준다.
- Claude 의 답을 복사할 수 있다. 답을 길게 누르거나 시각 앞의 ⋯ 를 누르면 Claude 가 쓴 Markdown 원문이 보이고, 통째로 복사하거나 일부를 골라 복사한다. `/copy` 는 VS Code 처럼 마지막 답을 복사한다.
- 대화를 Markdown 파일로 내보낼 수 있다. ⋯ 메뉴(더 보기 아래 대화 내보내기), `/export`, 답의 메뉴에서 한다. 턴마다 휴대폰 시간대의 시각이 붙은 머리글, Claude 가 쓴 글 그대로, 그리고 끄지 않으면 도구 호출마다 한 줄이 들어간다. 브로커가 대화 기록으로 만들므로 멈춘 세션도 내보낼 수 있다. 통째로 복사하거나, 파일처럼 1분 동안 유효한 티켓으로 내려받는다. 내보낼 때마다 글 없이 감사 로그에 남긴다.
- 사용량 시트(`/usage`)가 요금제 한도 다음에, 지난 하루와 한 주의 사용량이 어디에 쓰였는지 보여 준다. Claude Code 가 VS Code 의 Account & usage 를 위해 이 컴퓨터의 대화 기록에서 읽는 그대로다. 사용량의 10분의 1 이 넘는 특성과 그 대처법(Claude Code 2.1.301 이 이름을 주는 것은 앱의 언어로 된 이름으로, 아니면 Claude Code 의 키로), 가장 많이 쓴 서브에이전트·스킬·플러그인·MCP 서버, 그리고 각각의 표가 나온다. Context 시트에는 "사용량 원인 보기"가 있다. 답은 세션 자신의 Claude Code, 돌고 있는 다른 Claude Code, 또는 이 질문을 위해 시작한 Claude Code 가 주고, 5분 동안 둔다. VS Code 세션은 그 탭이 이 버전의 래퍼를 쓰면 직접 답한다.
- VS Code 의 입력 상자처럼 Context 링 옆에, 마지막 답 뒤 프롬프트 캐시가 몇 분 남았는지 또는 만료됐는지 보여 준다. Context 시트는 세션이 얼마나 쉬었는지, 다음 메시지가 몇 토큰을 다시 캐시하는지 알려 준다. 마지막 응답의 요청에서 Claude Code 가 요청한 유지 시간(`cache_creation`)을 따르고, 멈춘 세션은 대화 기록에서 구한다.
- 계획의 줄마다 코멘트를 달 수 있다. 계획의 줄을 누르면 코멘트를 쓰고, 다시 누르면 고친다. "계속 계획하기"는 피드백 뒤에 `줄 n "<the line>": <comment>` 형식으로 코멘트를 보낸다(영어 화면이면 `Line n "<the line>": <comment>`). 코드 블록은 첫 코드 줄로 가리킨다.
- 터미널, 백그라운드, `claude -p`, 래퍼보다 먼저 연 VS Code 탭에서 연 세션이 휴대폰의 글을 받는다. 다른 세션의 메시지를 받는 Claude Code 의 수신 소켓을 쓴다(Claude Code 2.1.224 이상). Claude 는 이를 다른 세션 "ccrc 휴대폰"(영어 화면이면 "ccrc phone")의 메시지로 받는다. 입력창은 보내기 전에 이를 알린다. Claude 가 세션이 도는 곳에서 무엇을 다시 묻는지, "/" 명령은 실행되지 않는다는 것, 그리고 대화 기록의 마지막 권한 모드와 ccrc 가 읽을 수 있는 `crossSessionInbound` 설정으로 보아 메시지가 터미널이나 `claude agents` 에서 승인을 기다리는지, 아예 전달되지 않는지를 알린다. 메시지는 대화 기록에 나타날 때까지 대화 아래에서 기다린다. 이런 세션은 목록에서 더는 "보기만"으로 나오지 않고, 백그라운드 세션은 백그라운드에서 열린 것으로 나온다. 다른 수신 형식의 세션은 보기만 된다.
- iOS 에서, 아직 기다리는 요청의 알림이 온 지 2분 안에 앱이 앞으로 나오면 그 요청의 카드로 간다. 요청마다 한 번이다. iOS 는 알림으로 앱을 열면서 알림이 가리키는 곳으로 가지 않을 수 있기 때문이다. 알림 탭이 앱에 닿으면 그 탭이 대신 정하고, 서비스 워커는 앱을 여는 주소에 표시(`?tap=1`)를 붙인다. 다른 플랫폼, 새 세션 초안, 이미 답한 요청은 건드리지 않는다. 어떤 요청이었는지는 브로커가 알려 준다(`GET /api/push/recent`).
- 설정 키 `vscodeArchive`(기본 `false`. 휴대폰의 알림과 입력 > 세션 목록에서도 바꾼다). VS Code 의 Claude Code 확장이 보관한 세션(손으로, 또는 정한 날 수 동안 쓰지 않아서)을 ccrc 목록에서도 보관으로 세고 "VS Code 보관" 표시를 붙인다. VS Code 상태 데이터베이스는 읽기만 한다. 그런 세션을 휴대폰에서 다시 꺼내거나 메시지를 보내면 목록에 남기고(`<stateDir>/vscode-unarchived.json`) VS Code 에서는 보관된 채로 둔다. VS Code 가 그 세션을 다시 보여 주면 표시가 사라진다.
- Claude Code 의 대화상자에 휴대폰에서 답할 수 있다. 모델이 메시지를 거절하고 Claude Code 가 어떻게 할지 물으면(`switchModelsOnFlag` 가 꺼져 있을 때), 카드는 대체 모델로 계속하기, 메시지 고치기(입력창으로 돌아온다), 닫기를 내놓는다. Auto 모드 분류기가 이제 과금되는 요청을 돌린다는 안내에는 계속하기와 턴 중지를 내놓는다. 단추는 카드가 보이고 0.5초가 지나야 눌린다. 브로커 세션은 거절 대화상자를 Claude Code 에 등록하므로, Claude Code 는 턴을 끝내는 대신 묻는다. Auto 모드 안내는 등록하지 않으므로, 거기서는 전처럼 Claude Code 가 묻지 않고 Auto 모드로 계속한다. 아무도 답하지 않은 대화상자는 `dialogExpiry`(기본 5분) 뒤 Claude Code 가 기본값으로 닫는다. 거절은 그대로이고 턴이 끝나며, Auto 모드 안내는 턴을 멈춘다. VS Code 세션은 이 버전의 래퍼가 있어야 한다(hello 의 `caps` 에 `user_dialogs`). 래퍼는 대화상자가 내놓은 답만 넘기고, VS Code 에 자기 쪽 대화상자를 닫으라고 알린다. Fable 의 사용 크레딧 동의는 VS Code 에 남는다. 휴대폰은 무엇을 묻는지와 남은 크레딧을 읽기 전용으로 보여 준다. 대화상자 알림은 무엇을 묻는지 이름을 알려 준다.
- 휴대폰에서 MCP 서버에 로그인. MCP 시트는 로그인이 필요한 HTTP·SSE 서버나 claude.ai 커넥터에 "인증"을 내놓는다. Claude Code 가 로그인을 시작하고(`mcp_authenticate`) 휴대폰이 그 페이지를 연다. 마지막 페이지는 Claude Code 가 컴퓨터의 `localhost` 로 보내는 리디렉트라 휴대폰이 열 수 없다. 그래서 그 주소를 시트에 다시 붙여 넣으면 Claude Code 가 거기서 로그인을 마치고(`mcp_oauth_callback_url`) 서버를 다시 연결한다. 코드가 든 `localhost` 리디렉트만 Claude Code 로 가고, 감사 로그에는 서버 이름만 남는다. VS Code 세션은 이 버전의 래퍼가 있어야 한다(`caps` 에 `mcp_auth`). 래퍼는 서버 이름만 넘기고(리디렉트는 Claude Code 가 고른다), 답에서는 페이지와 리디렉트가 돌아오는지만 넘긴다.
- 패스키(Face ID)로 원격 로그인을 확인한다. 휴대폰은 계정과 보안에서 비밀번호를 넣은 뒤, ccrc 를 여는 호스트 이름에 패스키를 등록한다. 그 뒤로 이 컴퓨터가 아닌 기기의 로그인은 모두 시작할 때와 `passkeyHours`(새 설정 키, 기본 18)가 지날 때마다 패스키로 확인한다. Claude 의 Remote Control 이 신뢰 기기에 하는 것과 같다. 확인 전까지 휴대폰은 패스키 화면만 보여 준다. 다른 허용 기기(두 번째 휴대폰이나 태블릿)는 처음 로그인할 때 비밀번호 다음에 그 화면에서 자기 패스키를 등록한다. 패스키를 등록한 기기는 그것으로 확인한다. 지울 때도 비밀번호를 묻는다. 휴대폰을 잃었을 때는 컴퓨터에서 `ccrc passkey [list | remove <id> | reset]` 으로 보고 지운다. `~/.config/ccrc/passkeys.json`(0600. 공개 키와 각각 쓴 때)에 두며, `ccrc uninstall --purge` 가 지운다. 브로커는 등록과 확인을 Node 의 crypto 로 직접 확인한다. 새 의존성은 없다. `ccrc rollback` 으로 0.7.x 로 돌아가면 확인이 꺼진다. 0.7 은 `passkeys.json` 을 읽지 않아 비밀번호만으로 로그인된다. 패스키는 남아 있으므로 다시 업데이트하면 확인이 돌아온다.
- 컴퓨터가 꺼져 있어도 읽는 최근 대화. 휴대폰은 마지막으로 보여 준 대화 다섯 개의 끝부분(하나에 최대 80항목 또는 160KB)을 브라우저의 IndexedDB 에 둔다. 오간 말, 도구 호출의 이름과 요약, 파일 이름이 들어간다. 도구 입력과 출력, diff, 명령 출력, thinking, 사진은 컴퓨터에만 있다. 브로커에 닿지 못할 때(컴퓨터가 꺼지거나 잠듦, Tailscale 끊김, 브로커가 멈추거나 오류로 답함)도 앱이 열리고 그 대화들을 보여 준다. 대화는 읽기 전용으로 열리고 그렇다고 알린다. 브로커가 답하면 앱은 살아 있는 대화로 돌아간다. 사본은 로그인에 딸려 있다. 로그아웃, 새 비밀번호(휴대폰에서 바꾸거나, 연결된 휴대폰이 바로 알게 되는 `ccrc passwd`), 컴퓨터에서 끝난 로그인(`ccrc logout`, 쉬는 시간 초과, 다른 기기의 로그인), 기기가 `allowedDevices` 에서 빠짐, 브로커에 닿지 못한 채 `leaseIdleMinutes` 가 지남(사본이 화면에 있을 때도), 패스키 확인 때가 됨이 모두 사본을 지운다. 계정과 보안의 "최근 대화를 휴대폰에 저장"(기본 켬)은 이를 끄고 지우며, 얼마나 들어 있는지 보여 준다. `/api/me` 는 로그인한 휴대폰에 `leaseIdleMinutes`, 비밀번호를 정한 때(`loginSetAt`), 패스키가 있으면 다음 확인까지 남은 시간(`passkeyLeftMs`)도 준다. 연결된 휴대폰은 브로커가 도는 동안 이 중 하나가 바뀌면 다시 묻는다.
- 다른 프로세스가 쥐고 있는 세션을 VS Code 가 열 때, 더는 말없이 복사본이 되지 않는다. 세션이 이 버전 래퍼의 다른 VS Code 탭에서 쉬고 있으면(돌거나 기다리거나 대기열에 든 것 없음, 백그라운드 작업 없음, CronCreate·ScheduleWakeup 으로 예약한 작업 없음) 바로 새 탭으로 옮겨 간다. 옛 탭의 Claude Code 는 탭을 닫을 때처럼 끝나고(입력이 닫히고 오류는 없다), 두 탭 모두 대화 아래 한 줄로 알린다. 옛 탭에서 보내면 다시 그쪽으로 옮겨 간다. 그렇지 않으면 새 탭은 전처럼 최대 9초 뒤 복사본을 열되, 어떤 종류의 프로세스가 원본을 쥐고 있는지(다른 VS Code 탭, 터미널, 백그라운드 세션)와 여기서 보낸 메시지는 원본에 닿지 않는다는 것을 알린다. 복사본 이름은 "(복사본) <title>"("(copy) <title>". 복사본의 복사본은 "(복사본 2)" 처럼 이어서 센다)이고, Claude Code 가 복사본의 첫 메시지와 함께 쓴다. 휴대폰은 복사본이 첫 메시지를 받을 때 한 번 알림을 받고, 활동 기록은 "VS Code 다른 탭에서 옮김" 과 "VS Code에서 복사본으로 엶" 을 구별한다. 안내 줄은 휴대폰 알림의 언어로 쓰고, 구독한 휴대폰이 없으면 컴퓨터 로캘의 언어로 쓴다. 래퍼는 이를 할 수 있다고 hello 에서 알린다(`hand_over`, `claim_notice`).
- README, 이 변경 기록, 보안 정책의 한국어판(`README.ko.md`, `CHANGELOG.ko.md`, `SECURITY.ko.md`). 영어판과 한국어판은 맨 위에서 서로 링크한다.

### 변경

- 빠진 기본 도구가 `ssh-keygen` 하나뿐이면 `install.sh` 가 더는 멈추지 않는다. 설치는 전처럼 sudo 를 물으며 권한다. 끝내 없으면(sudo 를 허락하지 않음, `--no-system`, 패키지 관리자 없음, 설치 실패) 설치될 때까지 `ccrc update` 가 서명 확인에서 멈춘다고 경고하고 설치를 계속한다. 설치에는 원래 쓰지 않았다. `install.sh` 는 태그 서명을 확인하지 않는다.
- 입력창의 에이전트 칩이 대화 내내 보인다. 대화가 서브에이전트나 워크플로를 쓰기 전에는 흐리게 보인다. 휴대폰이 보기만 할 수 있는 세션(VS Code 나 터미널에서 열려 있고 여기서 메시지를 받지 않음, 폴더가 사라짐, 원격 세션 꺼짐)에서는 입력창 대신 나오는 안내 옆에 있다. 누르면 에이전트 지도가 열리고, 쓴 에이전트가 없으면 그렇게 알린다. 돌고 있는 수는 두 자리 폭을 차지하고 도는 에이전트가 없으면 비워 두므로, 칩 폭이 바뀌지 않는다. Context 링은 클립 옆으로 옮겼다. 한 줄이면 클립, Context, 모델, Effort, 에이전트 … 권한 모드, 보내기 순서다. 한 줄에 들어가지 않으면 1줄에 에이전트 칩과 권한 모드, 2줄에 나머지가 온다. 새 세션 화면에는 링도 에이전트 칩도 없다.
- 휴대폰의 Claude Code 설정은 바꾸는 즉시 저장한다. 스위치나 선택은 고를 때, 글은 Enter 를 누르거나 칸을 떠날 때, 규칙이나 폴더는 더하거나 뺄 때 저장한다. 토스트가 무엇을 저장했는지 알리고 되돌릴 수 있다. 저장 막대, "변경 취소", 확인 시트는 없앴다. 저장은 바꾼 순서대로 한 번에 하나씩, 앞 저장이 남긴 파일을 기준으로 한다. 차례가 오기 전에 다시 바꾼 키는 한 번만 저장한다. 그사이 파일이 바뀌었어도 그 키를 건드리지 않았으면 바꾼 것을 그대로 저장하고, 아니면 파일의 값을 보여 준다.
- Claude Code 설정의 백업(`settings.json.ccrc-<time>.bak`)을 저장할 때마다가 아니라 고치는 10분마다 한 번 만든다. 마지막 10개와 함께, ccrc 가 처음 파일을 바꾸기 전의 백업도 남긴다.
- Claude Code 설정의 Effort 를 모델마다 정한다(`modelSettings.<model>.effortLevel`. `/effort` 가 저장하는 곳). Claude Code 가 Effort 단계와 함께 내놓는 모델과 파일에 적힌 모델마다 정한다. 맨 위의 `effortLevel`(0.7 의 Effort 행이 저장하던 것)은 자기 Effort 가 없는 옛 모델(Fable 5.1, Opus 5 등)에는 여전히 적용되지만 5.5 모델에는 적용되지 않는다. 이 값은 그 모델들의 행과 따로 된 행에 보이며, 그 행에서는 지우기만 할 수 있다.
- 앱 아이콘 배지는 답을 기다리는 세션과 읽지 않은 세션을 센다. 목록이 표시하는 세션과 같다. 어느 기기가 알림을 받았는지에 더는 좌우되지 않고, 저절로 시작한 턴이 배지를 지우지도 않는다.
- 더는 필요 없는 알림을 닫는다. 턴 끝, Claude 가 보낸 알림, 보낸 파일, 복사본의 첫 메시지 알림은 세션을 읽으면(휴대폰에서 열거나 VS Code 에서 그 세션에 메시지를 보내면), 요청 알림은 답하면 닫는다. 어떤 알림이든 같은 세션·같은 종류의 새 알림이 뜨면 닫는다(그러지 않으면 iOS 는 둘 다 둔다). 휴대폰은 앱이 앞으로 나올 때, 세션을 열 때, 목록이 바뀌었다고 들을 때(보고 있는 세션의 알림도 닫는다), 다음 알림이 올 때 이렇게 한다. 이제 모든 알림이 만든 시각과, 읽지 않았거나 답을 기다리는 세션의 id 를 담는다. 테스트 알림과 업데이트 안내에도 배지가 실린다. 그 id 들을 담으면 너무 길어지는 알림은 id 없이 간다. 앱이 닫혀 있는 동안에는 휴대폰에 다른 신호가 가지 않으므로, VS Code 에서 읽은 세션도 그때까지 알림이 남고 아이콘 숫자도 남는다. 설정의 "알림 끄기"와 로그아웃은 앱의 알림을 모두 닫는다. iOS 26.5 이상은 알림이 보인 지 30초 안에는 닫지 않는다. 그래서 앱이 앞에 있는 동안 30초가 지나면 다시 닫아 본다.
- 긴 세션이 휴대폰에서 더 빨리 열린다. 대화는 최근 40항목쯤으로 열리고, 위로 스크롤하면 앞부분을 불러오며 보던 자리를 지킨다. 한참 앞의 검색 결과나 서브에이전트는 그 주변 부분으로 열리고, 뒷부분은 화면에 들어올 때 불러온다. 브로커는 만든 대화를 대화 기록이 바뀔 때까지 두고, compact 한 대화 기록은 마지막 compact 부터만 읽으며, WebSocket 으로 보내는 것을 압축한다(permessage-deflate).
- 되돌리기 목록, 변경 사항 시트, 할 일 패널, 에이전트 칩, 에이전트 지도는 휴대폰이 대화의 어느 부분을 불러왔든 대화 전체를 다룬다.
- VS Code 래퍼가 `get_workspace_diff`(요청의 다른 것은 넘기지 않는다)와 `side_question`(질문과 그 스레드, 글만), 브로커 곁질문의 진행과 취소도 넘기고, 그렇다고 hello 로 브로커에 알린다(`workspace_diff`, `side_question`). 업데이트 전에 연 VS Code 탭은 다시 열 때까지 옛 래퍼를 쓴다. 그 탭에서는 곁질문이 꺼지고, git 변경은 브로커가 읽는다.
- NotebookEdit 호출은 Claude Code 가 바꾸기 전 셀 소스를 알려 주면 셀의 변경을 보여 준다.
- 세션 ⋯ 메뉴에는 타일 네 개와 많이 쓰는 행(곁질문, 되돌리기, 변경 사항, Context와 사용량, 에이전트 지도)을 남겼다. MCP 서버, 출력 스타일, 읽지 않음으로 표시, worktree 정리, 원격 실행 끝내기는 마지막 행인 더 보기 아래로 옮겼다. 더 보기는 이것들을 같은 시트에 보여 주고, 메뉴로 돌아가면 보던 자리로 간다. 대화 내보내기도 거기에 있다. 메뉴는 모든 세션에서 같은 행을 가지며, 턴이 도는 동안 맨 위에 이번 턴 중지가 붙어도 390×844 화면에 들어간다.
- "/" 목록이 세션 도중 Claude Code 가 알리는 명령을 따른다(명령이나 스킬 파일을 썼을 때, 플러그인이나 스킬을 다시 불러왔을 때). 브로커가 돌리는 세션과 VS Code 모두 그렇다. Claude Code 가 자기 터미널에 묶은 명령(`/color`, `/focus` 등)은 뺀다. 브로커 세션의 목록은 첫 턴이 아니라 시작할 때부터 안다. 래퍼는 새로 연결한 브로커에 최신 목록을 다시 넘긴다.
- `claude -p` 로 돌린 세션은 "sdk-cli" 대신 "SDK" 에서 열린 것으로 보인다.
- iPhone 에서 키보드가 올라와 있을 때 세션 ⋯ 메뉴를 열면 키보드를 내린 뒤 온전한 높이로 연다.
- `ccrc status` 가 패스키를 보여 주고, `ccrc setup` 이 휴대폰에서 패스키를 등록하는 법을 알려 준다.

### 고침

- `ccrc update` 가 git 설정에 `gpg.ssh.program` 이 있으면 그것으로, 그 설정의 `gpg.minTrustLevel` 에 따라 릴리스 서명을 확인했다. 서명만 하는 프로그램이나 신뢰 수준 `ultimate` 이면 올바른 서명에서도 업데이트가 멈췄다. 서명이 맞지 않는다거나 OpenSSH 8.2 가 필요하다고 알렸는데, `ccrc setup` 은 `ssh-keygen` 이 괜찮다고 했다. 이제 setup 이 확인하는 `PATH` 의 `ssh-keygen` 으로, `.ccrc-allowed-signers` 만 가지고 늘 확인한다.
- 에이전트가 시작하고 끝나는 세션에서 글을 쓰는 동안 입력창이 더는 움직이지 않는다. 에이전트 칩이 생겼다 사라지며 칩 줄 수가 바뀌었고, 도는 수가 칩 폭을 바꿨다. 창 크기가 바뀌면 입력칸도 글에 다시 맞추므로, 휴대폰을 돌린 뒤 첫 글자에 입력칸이 몇 픽셀 커지지 않는다.
- 대화 기록이 긴 첫 메시지(Claude 가 일하는 동안 쓴 것, 붙여 넣은 글이나 이미지가 든 것)로 시작하는 세션이 이름 없는 폴더 아래에 나오고 열리지 않았다. 이제 작업 폴더를 대화 기록에서 구하고, 기록에 없으면 같은 프로젝트 폴더의 다른 세션에서 구한다.
- 휴대폰 모델 시트에서 "Default (recommended)"를 고르면 `"model": "default"` 를 저장했다. Claude Code 는 이를 모델 이름으로 읽어, 기본 모델에 정한 Effort 가 적용되지 않았다. 이제 그 항목은 키를 지우는 시트의 "기본값"이고, "default" 는 모델로 저장하지 않는다. 파일에 이미 있는 값은 그대로 보여 주고 안내를 붙인다.
- 휴대폰에서 알림을 껐다 다시 켜도 전에 고른 것(VS Code 세션 알림, 작업 완료 알림, 도구 이름 표시)이 기본값으로 돌아가지 않고 남는다.
- 서브에이전트나 백그라운드 작업이 진행을 알리는 동안 대화가 더는 움직이지 않는다. 맨 아래에 있을 때만 맨 아래를 따라가고, 아니면 읽고 있는 곳을 그 자리에 둔다(Safari 에는 자체 스크롤 고정이 없다). 새 내용 표시는 메시지, 요청, 답이 올 때만 한다. 도는 서브에이전트 카드가 단계마다 줄었다 늘지 않고, 쓰는 동안 줄이 바뀌는 메시지가 대화를 끌어올리지 않는다.
- `ccrc update` 는 래퍼 프로토콜이 바뀌었을 때만 VS Code 창을 다시 불러오라고 했다. 업데이트 전에 연 Claude 탭은 새 래퍼의 기능(hello 의 `caps` 에 있는 이름)을 받을 때도 다시 불러와야 한다. 그래서 이제 새 기능이 있을 때도 그렇다고 말하고 그 이름을 알려 준다. 이 안내는 업데이트하기 전 버전이 한다. 0.7 에서 업데이트하면 여전히 나오지 않는다. "0.7 에서 업데이트할 때" 참고.
- 대화 머리글의 ⋯ 단추가 36px 정사각형에서만 눌렸다. 이제 뒤로 단추처럼 44px 에서 눌린다.
- 브로커에 닿지 못할 때 앱을 열면 Safari 가 페이지를 열 수 없다고 하거나, 브라우저 캐시에서 끝나지 않는 스피너가 나왔다. 이제 서비스 워커가 앱 페이지와 그 파일(`/assets/`, 지금 버전과 이전 버전)을 두었다가, 네트워크가 실패하거나 오류로 답하거나 3.5초보다 오래 걸리면 내준다. `/api/` 는 다루지 않는다. 그다음 앱은 몇 초마다, 그리고 "다시 연결"을 누를 때 브로커에 다시 묻는다.
- 연결이 끊긴 동안 네트워크에서 실패한 요청이 세션 목록에 10초마다 "Failed to fetch" 토스트를 띄우지 않는다. "연결이 끊겼습니다" 띠도 다시 연결을 시도하는 사이에 내려가지 않는다.
- iPhone 에서 열린 시트(예: ⋯ 메뉴) 주변의 어두운 배경을 끌면 페이지가 늘어났다. 손가락을 뗄 때까지 화면 위쪽 띠가 어두워지지 않고, 머리글이 화면 밖으로 나가고, 시트 아래가 잘렸다. 이제 어두운 배경이 페이지 전체를 덮고 끌기를 받지 않는다. 페이지 전체는 끝을 넘어 늘어나지 않는다(안의 목록은 여전히 늘어난다. Android 브라우저 탭에서는 아래로 당겨도 페이지를 다시 불러오지 않는다). 시트는 키보드가 올라왔거나 확대했을 때만 화면에 보이는 부분을 따라간다.
- iOS 27 은 홈 화면 웹 앱의 위쪽을 흐리게 한다. 이제 앱 화면과 파일·사진 뷰어의 머리글이 자기 배경을 가진 sticky 상자로 위쪽 끝에 닿는다. 그러면 iOS 는 흐림 대신 그 색을 상태 표시줄에 그린다. 시트가 열려 있을 때는 어두운 배경의 색이다.

### 보안

- 래퍼가 브로커의 `get_usage` 를 요청에 든 다른 것과 함께 Claude Code 에 넘겼다. 이제 `skip_behaviors` 만 받고, 답에서는 한도와 세션 합계 말고는 사용량 원인(특성, 서브에이전트·스킬·플러그인·MCP 서버의 이름과 비율)만 돌려준다. 답의 다른 것은 넘기지 않는다.
- `ccrc setup` 이 tailnet 의 모든 iOS·Android 기기를 `allowedDevices` 후보로 내놓았고, `--yes` 는 온라인인 기기를 모두 허용했다. 공유 tailnet 에 있는 다른 사람의 휴대폰도 들어갔다. 이제 이 컴퓨터가 속한 Tailscale 사용자의 기기만 내놓고, `--yes` 는 그런 기기가 정확히 하나일 때만 추가한다. 아니면 아무것도 추가하지 않고 내 기기를 추가하는 법을 알려 준다(터미널에서 `ccrc setup`, 또는 `ccrc config set allowedDevices`). 태그가 붙은 컴퓨터나 사용자를 알려 주지 않는 Tailscale 에서는 후보가 없다. config.json 에 이미 있는 목록은 그대로 둔다. 예전 `--yes` 가 내 것이 아닌 휴대폰을 들였는지 보려면 `ccrc status` 의 `devices` 를 본다.
- `ccrc update` 가 `versions/` 에 이미 있는 대상 버전 사본을 태그 확인 없이 썼다. 서명을 확인하지 않는 `install.sh` 가 남긴 사본이나, 더 옛 `.ccrc-allowed-signers` 로 확인한 업데이트가 남긴 사본이다. 이제 그런 사본도 내려받은 것처럼 확인하고, 통과하지 못하면 태그를 다시 받는다.
- `git verify-tag` 는 태그 이름을 보지 않아서, `ccrc update` 가 새 릴리스 이름으로 내민 옛 릴리스의 서명된 태그를 새 릴리스로 받아들였다. 이제 태그가 받아 온 그 이름으로 서명됐는지, 사본이 태그가 가리키는 커밋인지 확인한다.

### 0.7 에서 업데이트할 때

- 첫 번째 선호 언어가 한국어가 아닌 휴대폰은 업데이트 뒤 앱을 영어로 보여 준다. 한국어를 유지하려면 Settings > Language 에서 한국어를 고른다(이때 화면은 영어다).
- 0.7 에서 알림을 켠 휴대폰에는 업데이트 뒤 앱을 한 번 열 때까지 한국어로 알림을 쓴다. 앱을 열면 앱이 브로커에 언어를 알린다.
- 휴대폰이 새 서비스 워커를 받은 뒤부터 다음 알림이 더는 필요 없는 알림을 닫는다. 새 서비스 워커는 앱을 열 때 받는다. iOS 는 앱 전환기에서 앱을 닫고 다시 열 때까지 옛것을 쓸 수 있다.
- `ccrc update` 뒤에는 VS Code 창을 다시 불러온다(Developer: Reload Window). 0.7 에서 업데이트하면 이 안내가 나오지 않고, 업데이트 전에 연 Claude 탭은 다시 열 때까지 0.7 의 래퍼를 쓴다. 그때까지 그 탭의 세션에서는 다음과 같다.
  - 곁질문 시트, 그리고 "백그라운드로"를 내놓을 카드와 에이전트 지도는 대신 Claude Code 를 다시 열라고 한다.
  - 변경 사항 시트의 "git 전체"는 브로커가 읽는다.
  - 사용량 시트의 원인은 다른 Claude Code 가 준다.
  - 브로커가 없는 동안 Claude Code 가 바꾼 "/" 목록은 다음에 바뀔 때 보인다.
  - Claude Code 의 대화상자는 VS Code 에서만 답한다.
  - MCP 시트의 "인증"은 래퍼가 아직 모른다고 한다.
  - 휴대폰에 닿은 PushNotification 호출 뒤에 Claude 는 Claude Code 의 "not sent" 를 읽는다.
  - 다른 탭이 그 세션을 열어도 세션이 그 탭에서 옮겨 가지 않는다. 다른 탭은 최대 9초 뒤 복사본을 열고, 다른 복사본처럼 이름을 붙이고 알린다.

## [0.7.3] - 2026-10-18

### 고침

- OpenSSH 의 `ssh-keygen` 이 없는 컴퓨터는 ccrc 를 설치했지만, 그것으로 릴리스 서명을 확인하는 첫 `ccrc update` 에서 멈췄다. 이제 `install.sh` 는 `ssh-keygen` 을 기본 도구로 세어 함께 설치한다(`openssh-client`, `openssh-clients`, `openssh`. 전처럼 sudo 를 묻는다). `ccrc setup` 에는 왜 필요한지와 설치하는 법을 알려 주는 `ssh-keygen` 단계가 생겼다. `ccrc update` 는 서명이 맞지 않는다고 하는 대신 무엇을 설치할지, 또는 OpenSSH 가 8.2 보다 오래됐다고 알린다.

## [0.7.2] - 2026-10-18

### 추가

- GitHub Releases: 태그를 push 하면 `.github/workflows/release.yml` 이 `scripts/sync-releases.sh` 를 돌린다. 이 스크립트는 v0.7.0 부터 Release 가 없는 태그마다 Release 를 만들고, 그 CHANGELOG 절, 설치·업데이트 명령, 비교 링크를 담는다(`scripts/release-notes.sh`). `-` 가 든 태그는 pre-release 가 된다. `main` 으로 push 하거나 손으로 돌리면 실패한 실행이 빠뜨린 Release 를 채운다.
- CI: `.github/workflows/ci.yml` 이 `main` 과 `dev` 로 push 할 때와 pull request 에서 Node.js 22 로 `npm ci`, `npm run typecheck`, `npm test`, `npm run build` 를 돌린다.

### 보안

- 0.7.2 부터 릴리스 태그를 저장소 루트의 `.ccrc-allowed-signers` 에 있는 키로 SSH 서명한다. 0.7.2 이상의 설치본에는 그 파일이 있으므로, `ccrc update` 는 올라가는 태그마다 `git verify-tag` 로 확인하고 그 파일의 키로 한 SSH 서명이 없으면 멈춘다. 여기에는 OpenSSH 의 `ssh-keygen` 이 필요하다. 릴리스 워크플로도 그런 태그에는 Release 를 만들지 않는다. 0.7.1 이하에서 0.7.2 로 가는 업데이트는 확인하지 않는다. 태그를 손으로 확인하는 법은 README 의 "릴리스 확인하기"에 있다.

## [0.7.1] - 2026-10-18

### 변경

- sudo 동의를 더는 `--yes` 로 대신하지 않는다. `install.sh` 와 `ccrc setup` 은 sudo 를 쓸 때마다(기본 도구, Tailscale 설치 프로그램, `tailscale up`, `tailscale set --operator`, linger 에 필요할 때의 `sudo loginctl enable-linger`) 무엇을 왜 실행하는지 말하고 터미널에서 묻는다. `--yes` 가 있어도 같다. 터미널이 없으면 새 옵션 `--allow-sudo` 가 있을 때만 돌고, `install.sh` 는 이 옵션을 setup 에도 넘긴다. 없으면 `install.sh` 는 기본 도구를 설치하기 전에 멈추고, setup 은 그 단계를 "sudo consent needed" 로 남긴 채 sudo 가 필요 없는 단계를 계속하고 마무리하는 법을 알려 준다. `deploy/install-service.sh` 는 여전히 sudo 를 쓰지 않는다. `install.sh` 가 이전 버전(setup 이 `--yes` 를 sudo 동의로 받는 버전)을 설치할 때는, `--allow-sudo` 가 없으면 그 setup 을 `--yes` 없이 돌린다(터미널이 없으면 그 전에 멈춘다).

### 고침

- 새 버전 찾기가 실패하면(업데이트 확인과 `ccrc update`), 이제 메시지가 git 의 마지막 조언("and the repository exists.") 대신 이유를 말하는 git 출력 줄("Repository not found.", "Could not resolve host", 시간 초과)을 알려 준다. 저장소 URL 의 사용자 이름이나 토큰은 여전히 빼고 보여 준다.

## [0.7.0] - 2026-10-18

첫 공개 릴리스. 설치 프로그램, 업데이트, 그리고 작성자의 컴퓨터가 아닌 곳에서 돌기 위해 필요한 변경을 담았다.

### 호환성 깨짐

- VS Code 래퍼도 이제 `ccrc` 처럼 Node.js 22.18 이상이 필요하다(빌드한 중계기는 Node.js 20 에서 돌았다). 없으면 Claude Code 를 바로 돌리고 `wrapper.log` 에 남긴다. 그래서 VS Code 는 계속 동작하지만 휴대폰은 그 세션을 보거나 다루지 못한다.
- `bin/ccrc` 와 `bin/ccrc-wrapper` 가 더는 `~/.local/opt/node22` 를 보지 않는다. `CCRC_NODE`, `<dataDir>/node/bin/node`, 설치본이 기록한 Node.js, `PATH` 순서로 찾는다. 개발용 체크아웃은 업데이트하기 전에 이 중 하나가 있어야 한다. "0.6 에서 업데이트할 때" 참고.
- `allowedDevices` 는 내 tailnet 에서 기기의 MagicDNS 이름 첫 부분만 맞춰 본다. 기기가 스스로 알리는 호스트 이름은 더는 보지 않고, 다른 tailnet 에서 공유받은 기기는 절대 맞지 않는다. MagicDNS 이름과 다른 호스트 이름을 적은 항목은 더는 그 기기를 들이지 않는다.

### 추가

- `install.sh`: 플랫폼을 확인하고, 빠진 기본 도구를 설치하고(먼저 묻고 sudo 를 쓴다), Node.js 22.18 이상이 없으면 `SHASUMS256.txt` 로 확인한 Node.js 22 를 내려받고, ccrc 를 `~/.local/share/ccrc/versions/<version>` 에 빌드하고, `current` 와 `~/.local/bin/ccrc` 를 링크한 뒤 `ccrc setup` 을 돌린다. 옵션은 `--version`, `--ref`, `--from`, `--channel stable|rc`, `--yes`, `--dry-run`, `--no-system`, `--uninstall` 이다. 다른 옵션과 `--` 뒤의 모든 것은 `ccrc setup` 으로 간다. 환경 변수는 `CCRC_REPO_URL`, `CCRC_DATA_DIR`, `CCRC_STATE_DIR`, `CCRC_NODE`, `CCRC_NODE_DIST` 다. 기존 설치가 기록한 Node.js 를 다시 쓰고, `<stateDir>/install.log` 에 기록한다.
- `ccrc setup [--yes] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]`: 각 부분(Claude Code, Tailscale 설치·로그인·operator, MagicDNS 와 HTTPS, 허용할 휴대폰, ccrc 로그인, 설정, 서비스, `tailscale serve`, VS Code 래퍼 설정, 휴대폰, 호환성 점검)을 확인하고 빠진 것만 한다. 다시 돌리면 마저 끝내거나 고친다. 브로커 세션의 로그인 방식을 묻고, 백업한 뒤 VS Code 의 `settings.json` 을 주석과 배치를 지키며 그 자리에서 고친다. config.json 에 이미 있는 설정(빈 `roots` 목록도)은 그대로 두고, 옵션 없는 `tailscale up` 으로 Tailscale 에 로그인해 컴퓨터의 다른 Tailscale 설정을 지키며, linger 를 켜기 전에 묻는다. `--yes` 면 sudo 를 쓰는 단계도 묻지 않고 돈다.
- `ccrc uninstall [--purge] [--yes] [--dry-run]`: VS Code 의 래퍼 설정을 먼저 지우고, 그다음 서비스, `tailscale serve`, 설치된 버전들을 지운다. `--purge` 는 설정과 상태도 지우고, VS Code 설정의 백업은 `settings.json` 옆에 남긴다. 서비스나 VS Code 가 돌리는 개발용 체크아웃이 아직 `<dataDir>/node` 를 쓰면 그것은 남긴다.
- `ccrc update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repo>[@<ref>]]`: 돌고 있는 버전 옆에 릴리스를 빌드하고, 바뀐 것을 보여 주고, 설정과 상태를 백업해 옮기고, `current` 링크를 바꾸고, 서비스를 다시 시작해 `/api/ping` 을 확인한다. 새 버전이 답하지 않으면 스스로 되돌린다(종료 코드 3. 옛 버전도 확인하지 못하면 4). 실패한 업데이트는 설정과 상태를 정확히 원래대로 돌려놓는다. 전환을 확인하거나 되돌릴 때까지 Ctrl-C 를 미룬다.
- `ccrc rollback`: 마지막 업데이트 전 버전으로 돌아가고, 그 업데이트의 migrate 가 바꿨다고 알린 설정·상태 파일을 되돌린다(`ccrc migrate --json`). 서비스를 다시 시작하지 못하면 종료 코드 4 로 끝난다.
- `ccrc update`, `ccrc rollback`, setup 의 service 단계, `ccrc uninstall` 은 `ccrc.service` 안(휴대폰에서 시킨 세션처럼 브로커가 시작한 세션)에서는 돌지 않는다. 서비스를 다시 시작하면 중간에 멈추기 때문이다.
- 업데이트와 되돌리기는 가장 새 백업 셋과 마지막 기록 세 개의 백업을 남기고 더 오래된 것은 지운다.
- `<dataDir>/history.json`: 업데이트와 되돌리기마다 그 백업 폴더와 함께 남기는 기록.
- 선택적인 태그 서명 확인: 설치본에 `.ccrc-allowed-signers` 가 있으면 `ccrc update` 는 `git verify-tag`(SSH 서명)를 통과해야 진행한다.
- 브로커의 새 릴리스 확인. 시작하고 1분 뒤, 그 뒤로 하루 한 번(시간 제한이 있는 `git ls-remote`) 확인하고 `<stateDir>/update-check.json` 에 둔다. 설정 키는 `updateCheck`, `updateChannel`, `updateRepo`, `updateNotify` 다. 설치본은 새 릴리스마다 구독한 휴대폰에 푸시 알림을 한 번 보낸다.
- 설정의 상태 화면과 `/api/health` 가 ccrc 버전, 설치본인지 개발용 체크아웃인지, 바뀐 것으로 가는 링크가 달린 최신 릴리스, 마지막 확인 시각을 보여 준다.
- `brokerSessions` 설정(`off`, `apiKey`, `subscription`): ccrc 가 Agent SDK 로 직접 시작하는 세션을 띄울지, 어떻게 로그인할지 정한다. 새 설치의 기본값은 `off` 다.
- `apiKey` 면 브로커 세션이 `ccrc config set-api-key` 로 저장한 키(`<configDir>/anthropic-api-key`, 0600)를 받고, 다른 것은 그 키를 보지 못한다.
- 브로커 세션이 꺼져 있거나 키가 없으면 휴대폰은 새 세션 단추를 흐리게 하고, 이유와 켜는 법을 보여 주고, 시작과 갈래 동작을 숨긴다. 상태 화면은 모드를 읽기 전용으로 보여 준다. 브로커가 도는 동안 키를 저장하면 열린 휴대폰이 바로 안다.
- 터미널에서 config.json 을 읽고 바꾸는 `ccrc config path | get [key] | set <key> <value> | set-api-key`.
- `ccrc update --from` 은 설치본이 전에 릴리스를 찾던 곳을 기록한다(설치 정보의 `updateSource`). 그래서 로컬 작업을 시험해도 새 릴리스 확인이 GitHub 를 떠나지 않는다.
- `ccrc version`(과 `--version`): 설치된 버전, 개발용 체크아웃이면 `git describe`, 아니면 package.json 의 버전.
- `GET /api/ping` 은 로그인 없이 `{ ok, version }` 으로 답한다. 이 컴퓨터에는 늘, 그리고 허용된 기기에 답한다.
- config.json 을 읽을 때 검사한다. 형식이 틀린 키는 그 키와 받는 형식을 알리고 브로커를 멈춘다. 모르는 키는 경고하고, 깨진 JSON 은 줄과 열을 알린다.
- 돌고 있는 브로커가 `allowedDevices`, `allowLocal`, `roots`, `brokerSessions`, `leaseIdleMinutes`, `sessionIdleMinutes`, 업데이트 키의 변경을 다시 시작하지 않고 반영한다. `host`, `port`, `claudePath` 는 다시 시작해야 한다고 로그에 남긴다.
- config.json 에 `schemaVersion` 이 생겼다. `ccrc serve` 와 `ccrc migrate` 는 옛 파일을 `<stateDir>/backup/` 에 복사한 뒤 최신 형식으로 바꾼다. 더 새 ccrc 가 쓴 파일은 거부하고 업데이트하거나 되돌리라고 알린다.
- `CCRC_VSCODE_EXTENSIONS_DIR` 로 VS Code 확장 폴더를 정한다.
- 공개용 README, 이 변경 기록, 라이선스(MIT), 보안 정책.

### 변경

- `ccrc status` 가 버전, 브로커가 본 최신 릴리스, `brokerSessions` 모드도 보여 준다.
- `deploy/install-service.sh` 가 setup 의 service 단계를 돌린다. 설치본이면 유닛이 `<dataDir>/current/bin/ccrc serve` 를 돌리고, `CCRC_NODE` 를 기록하고, `/api/ping` 을 확인한다. 바꾸는 유닛은 `<stateDir>/backup/` 에 복사하고, setup 이 쓰지 않는 `Environment` 줄은 옮겨 온다. linger 는 선택이고 `--yes` 면 있는 그대로 둔다. 서비스만 바꾸고 VS Code 설정은 바꾸지 않는다.
- package.json 에 버전을 적는다.
- 새 의존성: `jsonc-parser`.

### 고침

- Claude Code 폴더가 설정 파일만이 아니라 모든 곳에서 `CLAUDE_CONFIG_DIR` 를 따른다.
- `PATH` 에 Node.js 가 없는 데스크톱에서 VS Code 를 띄웠을 때, VS Code 래퍼가 조용히 ccrc 없이 Claude Code 를 돌리는 대신 설치된 Node.js 를 찾는다.

### 보안

- `install.sh`, `ccrc setup`, `ccrc uninstall` 은 root 로 돌지 않는다.
- `ccrc uninstall` 은 `/`, 홈 폴더, `~/.config`, `~/.local`, `~/.local/share`, `~/.local/state`, `~/.cache`(또는 `XDG_*` 폴더)나 이것을 품은 폴더를 절대 건드리지 않는다. 폴더를 통째로 지우는 것은 이름이 `ccrc` 일 때뿐이고, 그 밖에서는 ccrc 가 만드는 것만 지운다.
- 휴대폰 설정 편집기가 남기는 Claude Code 설정 사본(`settings.json.ccrc-<time>.bak`)을 파일 뷰어, 첨부, `@` 제안에서 `settings.json` 처럼 비밀 파일로 다룬다.
- `install.sh` 가 자기 로그를 나만 보게 두고(상태 폴더 0700, `install.log` 0600), https 출처에서 받는 Node.js 가 https 를 벗어나지 않게 한다.
- API 키는 로그, 감사 로그, 화면, API 답에 절대 들어가지 않는다. `apiKey` 모드에서는 물려받은 `CLAUDE_CODE_OAUTH_TOKEN` 을 브로커 세션의 환경에서 뺀다.
- 새 릴리스 확인은 비밀번호 묻기나 자격 증명 도우미 없이 git 을 돌리고, 상태 화면에 보이는 오류에서 저장소 URL 의 사용자 이름이나 토큰을 가린다.

### 0.6 에서 업데이트할 때

- 개발용 체크아웃은 서비스를 다시 시작하기 전만이 아니라 **업데이트하기 전에**(`git pull` 이나 `git merge`) Node.js 22.18 이상을 찾을 수 있어야 한다. VS Code 는 체크아웃의 `bin/ccrc-wrapper` 를 바로 돌리므로, 새 코드가 들어온 순간부터 Node.js 를 찾지 못하면 새 Claude 탭이 ccrc 없이 돌고, 서비스는 다음 재시작에서 시작하지 못한다. 데스크톱에서 띄운 VS Code 와 서비스는 `PATH` 에 Node.js 가 없을 때가 많다. 먼저 링크를 만들고, 업데이트한 뒤, `ccrc` 가 `PATH` 없이 Node.js 를 찾는지 확인한다.

  ```bash
  mkdir -p ~/.local/share/ccrc && ln -s /path/to/node-v22 ~/.local/share/ccrc/node
  ~/.local/share/ccrc/node/bin/node --version      # v22.18 이상
  git pull                                         # 또는 git merge
  env -i HOME=$HOME PATH=/usr/bin:/bin bin/ccrc version
  ```

  이 링크는 `ccrc` 와 래퍼 모두에 쓰인다. `deploy/install-service.sh`(Node.js 22.18 이상을 찾는 셸에서 돌린다)는 그 Node 를 서비스 유닛에 `CCRC_NODE` 로 쓰는데, 그 값은 서비스만 읽는다. 링크가 없으면 래퍼에는 대신 `claudeCode.environmentVariables` 에 `CCRC_NODE` 를 넣어야 한다.
- 0.6 에는 `ccrc update` 가 없다. 체크아웃을 업데이트하거나(`git pull`, `npm ci`, `npm run build`, 그다음 `systemctl --user restart ccrc.service`), `install.sh` 로 설치본으로 옮긴다. `install.sh` 는 설정, 로그인, 알림 구독을 그대로 두고 서비스와 VS Code 가 설치본을 가리키게 한다.
- 0.7 은 처음 시작할 때 `config.json` 을 `schemaVersion: 1` 로 옮기고 `"brokerSessions": "subscription"` 을 더한다. 그래서 브로커 세션은 전처럼 동작한다. 이전 파일은 `<stateDir>/backup/migrate-0-1-<time>/` 에 남는다. 브로커 세션을 끄거나 API 키로 옮기려면 `ccrc config set brokerSessions off`(또는 `ccrc config set-api-key` 뒤에 `apiKey`)를 쓴다.
- `allowedDevices` 의 이름마다 기기의 MagicDNS 이름 첫 부분인지 확인한다(`tailscale status`).
- 열린 탭이 새 래퍼를 쓰도록 VS Code 창을 다시 불러오고, 휴대폰의 홈 화면 앱을 완전히 닫았다 다시 연다.

### 확인한 환경

- Claude Code VS Code 확장과 CLI 2.1.301, Claude Agent SDK 0.3.296
- Node.js 22.18 이상, systemd 255 의 Ubuntu 24.04, Tailscale 1.104.1
- iOS 16.4 이상(알림을 받으려면 홈 화면 앱)

## [0.6.0] - 2026-10-16

### 추가

- 세션 이름 바꾸기(VS Code 와 `claude --resume` 에도 보인다)와 ccrc 안에서 보관하기.
- 메뉴나 아무 메시지에서 세션을 갈래로 떼어, 백그라운드로 돌 수 있는 새 브로커 세션으로 만든다. `/fork` 와 `/branch` 는 갈래 시트를 연다.
- Claude Code 처럼 대화를 되돌린다: 대화와 코드, 대화만, 코드만. 브로커 세션은 제자리에서 되돌리고, VS Code 세션은 그 지점에서 갈래로 이어 간다.
- 새 git worktree 에서 새 세션을 시작하고, 세션 메뉴에서나 보관할 때 worktree 를 정리한다.
- 지금 세션의 Fast 모드와 Thinking 스위치. 입력창에 표시가 붙는다.
- Claude 가 휴대폰으로 파일을 보낼 수 있다(`SendUserFile`, Claude Code 2.1.300 이상). 참조로 열고, 비밀 파일은 막고, 한도는 50 MB 다. `CCRC_SEND_FILES=0` 으로 끈다.
- 에이전트 지도: 서브에이전트 기록, 셸과 모니터 작업의 출력을 읽는다.
- 작업 완료 알림 세 가지(휴대폰에서 보낸 세션, 모든 세션, 끔), 앱 아이콘 배지, 오류·사용 한도·Claude Code 비정상 종료에 따로 쓴 문구와 긴급도. 작업 완료 알림은 브로커를 다시 시작해도 남는다.
- VS Code 에서만 답할 수 있는 요청은 알림에 그렇게 표시한다.

### 변경

- `claudePath` 의 기본값이 `"vscode"` 다. 브로커 세션은 가장 새 VS Code 확장에 든 CLI 를 쓴다.
- 입력창 칩은 한 줄에 들어가면 한 줄, 아니면 두 줄로 놓는다. 세션 메뉴는 자주 쓰는 동작 네 개를 앞에 둔다.
- Web Push 는 VAPID 서명을 여섯 시간 동안 다시 쓰고, 401 이나 403 이면 새 서명으로 한 번 더 시도한다.

## [0.5.0] - 2026-10-15

### 추가

- 제목과 메시지 글로 세션을 찾고, 찾은 메시지로 바로 간다.
- 세션마다 출력 스타일. 세션 메뉴에서 고른다.
- MCP 입력 요청(elicitation)에 휴대폰에서 답한다. 브로커 세션, 그리고 휴대폰에 닿을 수 있는 동안의 VS Code 세션에서 된다.
- 쉬고 있는 세션의 모델, Effort, ultracode, 권한 모드를 고를 수 있고, ccrc 가 그 세션을 시작할 때 적용한다. "지금 시작" 단추는 메시지 없이 시작한다.
- 모델 칩 옆의 Context 링. Context, 요금제 사용량, Compact 를 연다.
- AskUserQuestion, 계획 승인, 그 밖의 도구 19개의 전용 보기. 나머지는 원본 보기.
- 대기열의 메시지는 Claude Code 가 받아들일 때까지 아래에 보이고, 거둬들일 수 있으며, VS Code 와 맞춰진다.
- 전체 화면 뷰어가 있는 사진 미리보기, 맨 아래로 가는 단추, Claude 답 아래의 시각과 날짜 구분선.
- 입력창 기능을 모두 갖춘 새 세션 화면(`@`, `/`, 첨부, 칩).
- 에이전트 지도: 세션의 서브에이전트, 워크플로, 백그라운드 작업.
- 에이전트 보고와 다른 세션의 메시지를 접힌 카드로, `!` 명령을 셸 카드로 보여 준다.
- 가로 화면 배치. 노치와 홈 표시줄 영역을 비워 둔다.

### 변경

- Claude Code 에서 창을 여는 명령(`/context`, `/usage`, `/mcp`, `/model`, `/config` 등)은 휴대폰에서 시트를 열고 대화에 보내지 않는다.
- 첨부 단추가 한 번 눌러 iOS 선택기를 연다.
- 보내기와 중지가 한 단추다. Effort 칩은 값만 보여 준다.
- 브로커 세션이 자기 entrypoint 를 적으므로 VS Code 가 목록에 보여 준다. 이전 버전이 쓴 대화 기록은 백업한 뒤 고쳐 쓴다.
- `@` 제안에서 비밀 파일 이름을 뺀다.

## [0.4.0] - 2026-10-14

### 추가

- 모델, Effort, ultracode 가 Claude Code 가 알리는 값을 따른다. VS Code 에서 바꿨을 때도 같다. Effort 시트에 ultracode 스위치가 생겼다.
- 명령 결과 카드: `/usage` 는 한도마다 막대로, `/context` 는 항목별로, 나머지는 Markdown 으로 보여 준다. `/` 목록은 `/context`, `/usage`, `/cost`, `/stats`, `/mcp`, `/model` 의 시트를 연다.
- 파일 링크 뷰어: 답 안의 링크로 세션 폴더 안의 파일을 연다. 줄 앵커, 렌더링한 Markdown, 강조한 코드, 이미지, PDF, JSON·CSV 표를 보여 준다. 비밀 파일은 막고, 읽을 때마다 감사 로그에 남긴다.

### 변경

- 설정을 페이지로 묶었다. 칩과 메뉴 이름은 VS Code 를 따른다.
- 래퍼는 원격 플래그 설정에서 `effortLevel` 과 `ultracode` 만 받는다.

## [0.3.0] - 2026-10-14

### 추가

- 입력창의 첨부(올리기 전에 크기를 줄인 사진, PDF, 텍스트 파일), `@` 파일 언급, `/` 명령.
- 대화 안의 Edit·Write diff, 서브에이전트 활동, 할 일 막대.
- 세션 메뉴: 줄 코멘트를 다는 변경 사항, 중지할 수 있는 실행 중 작업, context 항목별 사용량, MCP 서버(상태, 켜고 끄기, 다시 연결), 메시지 시점으로 파일 되돌리기.
- 답을 기다리는 요청과, 휴대폰에서 보낸 턴이 끝났을 때의 Web Push 알림.
- 설정: Claude Code 설정 편집(허용한 키만, 백업과 함께), VS Code 확장이 바뀔 때마다 호환성 점검, 감사 로그, Enter로 보내기.
- 래퍼가 VS Code 창을 다시 불러와 끊긴 턴을 이어 가고, 새 탭을 VS Code 가 기억한 권한 모드로 시작한다.

### 보안

- 계획 승인은 네 가지 결정만 받고, 래퍼는 `bypassPermissions` 로 바꿀 원격 답을 모두 거부한다.
- `@` 제안은 git worktree 가 세션 폴더를 품을 때만 git 의 파일 목록을 쓴다.

## [0.2.0] - 2026-10-14

### 추가

- VS Code 래퍼(`bin/ccrc-wrapper`, `claudeCode.claudeProcessWrapper` 에 쓴다): VS Code 에서 연 세션을 휴대폰에서 다룬다(실시간 보기, 메시지, 중지, 모델, 모드, Effort, context 사용량).
- 권한 요청이 VS Code 와 휴대폰에 함께 뜬다. 먼저 한 답이 쓰인다.
- 브로커가 돌리는 세션은 VS Code 가 열면 넘겨준다. 다른 프로세스가 쥔 세션은 갈래로 열린다.
- 브로커가 꺼져 있어도 VS Code 는 계속 동작하고, 브로커가 돌아오면 래퍼가 다시 연결한다.
- 래퍼와 브로커는 `$XDG_RUNTIME_DIR/ccrc/` 의 개인 소켓에서 만나고, `/tmp` 는 절대 쓰지 않는다.

## [0.1.0] - 2026-10-13

### 추가

- systemd 사용자 서비스로 도는 `127.0.0.1:8737` 의 브로커와, `tailscale serve` 로 여는 휴대폰 웹 앱.
- 컴퓨터의 모든 Claude Code 세션을 폴더별로, 상태(ccrc 에서 도는 중, VS Code 나 터미널에서 열림, 쉬는 중)와 함께 보여 준다.
- 쉬는 세션은 메시지를 보내면 이어서 돈다. 새 세션은 세션이 있는 폴더나 `roots` 에서 시작한다.
- 실시간 스트리밍, 도구 카드, thinking 이 있는 대화 보기. 권한 요청, 질문, 계획 승인 카드. 모델, 권한 모드, Effort. 중지. Claude 가 일하는 동안 대기열에 넣는 입력.
- VS Code 에서 연 세션을 실시간으로, 읽기 전용으로 보여 준다.
- ID 와 Argon2id 로 해시한 비밀번호로 로그인, 거듭 실패하면 잠금, 원격 로그인은 한 번에 하나, 12시간 쉬면 로그아웃.
- 허용한 tailnet 기기만 들어온다. Origin 확인, 엄격한 쿠키, Content Security Policy. 원격에서는 `bypassPermissions` 를 고를 수 없다.
- 쉬는 브로커 세션 프로세스는 15분 뒤 닫는다. 메시지 내용 없는 감사 로그. 라이트·다크 테마.
- `ccrc serve | passwd | status | logout` 과 `deploy/install-service.sh`.

[Unreleased]: https://github.com/rjs0429/ccrc/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/rjs0429/ccrc/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/rjs0429/ccrc/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/rjs0429/ccrc/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/rjs0429/ccrc/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/rjs0429/ccrc/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/rjs0429/ccrc/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rjs0429/ccrc/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rjs0429/ccrc/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rjs0429/ccrc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rjs0429/ccrc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rjs0429/ccrc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rjs0429/ccrc/releases/tag/v0.1.0
