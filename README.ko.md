# ccrc

[English](README.md) | 한국어

VS Code 에서 돌고 있는 Claude Code 세션을 휴대폰에서 다룬다. 제삼자 중계 서버는 거치지 않는다.

ccrc 는 내 리눅스 컴퓨터에서 작은 브로커를 돌리고, 휴대폰 웹 앱을 내 [Tailscale](https://tailscale.com) 네트워크(tailnet)에 연다. 휴대폰에서는 이 컴퓨터의 모든 Claude Code 세션을 폴더별로 본다. 턴이 도는 모습을 따라 보고, 메시지와 첨부를 보내고, 권한 요청·질문·계획 승인에 답하고, 모델·권한 모드·Effort 를 바꾼다. VS Code 에서 연 세션은 작은 래퍼를 거쳐 다룬다. VS Code 의 Claude Code 확장이 CLI 를 이 래퍼로 띄운다. 쉬고 있는 세션을 다시 잇거나 새 세션을 시작하는 일은 브로커가 직접 한다.

- **개인용 도구.** 각자 자기 컴퓨터에 ccrc 를 설치하고 자기 Claude Code 로그인으로 쓴다. ccrc 서버는 없다. 휴대폰은 tailnet 을 거쳐 내 컴퓨터와 바로 통신하고, 대화 기록은 컴퓨터에 남는다(휴대폰은 컴퓨터가 꺼져 있을 때 읽을 수 있도록 마지막으로 보여 준 대화들의 끝부분만 둔다. [보안 모델](#보안-모델) 참고). Claude Code 자체는 늘 하던 대로 Anthropic API 와 통신한다.
- **Anthropic 제품이 아니다.** ccrc 는 Anthropic 이 만들거나 보증하거나 지원하는 것이 아니다. Claude Code 를 포함하거나 고치지 않는다([라이선스와 Anthropic 약관](#라이선스와-anthropic-약관) 참고).
- **한국어 또는 영어 화면.** 휴대폰 앱은 휴대폰의 첫 번째 언어가 한국어면 한국어로, 아니면 영어로 보인다. 앱 설정에서 언어를 고르면 그것을 따른다. 영어는 아직 화면 일부만 덮고, 나머지는 한국어로 보인다. 명령줄은 영어이고, 문서는 영어와 한국어로 있다.

### 확인한 환경

| 구성 요소 | 버전 |
|---|---|
| Claude Code VS Code 확장과 CLI | 2.1.301 (Claude 가 휴대폰으로 보내는 파일은 2.1.300 이상) |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 0.3.296 |
| Node.js | 22.18 이상 |
| OS | systemd 가 있는 리눅스(Ubuntu 24.04, systemd 255), x86_64 또는 aarch64 |
| Tailscale | 1.104.1 |
| 휴대폰 | iOS 16.4 이상, Safari, 홈 화면에 추가(알림에 필요) |

`ccrc setup` 과 설정 화면(상태와 점검)은 설치된 확장과 호환되는지 점검한다. 더 새 Claude Code 도 대개 동작하고, 동작하지 않으면 점검이 알려 준다.

### 휴대폰이 띄우는 세션의 로그인 방식 (`brokerSessions`)

세션은 두 가지다.

- **VS Code 세션**은 VS Code 확장이 띄우는 Claude Code 다. 로그인은 Claude Code 를 설정한 방식 그대로다. ccrc 는 중계만 한다. 늘 동작한다.
- **브로커 세션**은 ccrc 가 Claude Agent SDK 로 직접 띄우는 세션이다. 휴대폰에서 연 새 세션, 쉬던 세션 다시 잇기, 갈래, 새 worktree 세션이 여기에 든다. 휴대폰 화면에서는 "원격 세션"이라고 부른다.

Anthropic 의 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 페이지는 Agent SDK 로 만든 제품의 개발자에게 API 키 인증을 쓰라고 하고, 사용자를 대신해 Free·Pro·Max 요금제 자격 증명으로 요청을 보내는 것을 허용하지 않는다. 고치지 않은 Claude Code 에 자기 구독으로 로그인하는 것은 막지 않는다. 그래서 ccrc 는 브로커 세션을 `brokerSessions` 설정으로 사용자에게 맡긴다.

| 값 | 브로커 세션 |
|---|---|
| `off` (새 설치의 기본값) | 띄우지 않는다. 휴대폰은 VS Code 세션을 그대로 보고 다루며, 지난 세션도 읽는다. |
| `apiKey` | `ccrc config set-api-key` 로 저장한 Anthropic API 키로 로그인한다. 사용료는 그 키로 청구된다. |
| `subscription` | 이 컴퓨터의 Claude Code 로그인을 쓴다. ccrc 0.6 이하가 이렇게 했다. |

Anthropic 약관을 읽고 내 쓰임에 맞는 것을 고른다. ccrc 가 대신 정하지 않으며, 이 글은 법률 조언이 아니다. 언제든 `ccrc config set brokerSessions <value>` 로 바꿀 수 있고, 돌고 있는 브로커가 바로 반영한다.

## 필요한 것

- systemd 사용자 세션이 있는 리눅스(데스크톱 로그인, 또는 systemd 컴퓨터에 SSH 로 접속), x86_64 또는 aarch64. macOS, WSL, VS Code Remote-SSH 는 지원하지 않는다.
- Anthropic 의 Claude Code 확장이 있는 VS Code, 또는 Claude Code CLI. 로그인돼 있어야 한다.
- Tailscale 계정. 설치 프로그램이 컴퓨터에 Tailscale 을 설치한다. tailnet 에서 MagicDNS 와 HTTPS 인증서를 켜야 한다(어디서 켜는지 setup 이 알려 준다).
- 휴대폰의 Tailscale 앱. 컴퓨터와 같은 Tailscale 계정으로 로그인한다. setup 은 그 계정의 휴대폰만 후보로 보여 준다(다른 기기는 이름으로 허용할 수 있다).
- Node.js 22.18 이상과 npm, git, curl, tar, xz, sha256sum, OpenSSH 의 `ssh-keygen`.
  - `ssh-keygen` 은 SSH 클라이언트에 들어 있다. Debian·Ubuntu 는 `openssh-client`, Fedora·RHEL·openSUSE 는 `openssh-clients`, Arch 는 `openssh` 패키지다. `ccrc update` 가 0.7.2 부터 릴리스 태그의 서명을 확인할 때 쓰며, OpenSSH 8.2 이상이어야 한다(RHEL 8 은 8.0). 없어도 ccrc 는 설치되고 돈다. `ccrc update` 만 멈춘다.
  - 설치 프로그램은 빠진 기본 도구를 설치할지 묻고, Node.js 가 없으면 Node.js 22(npm 포함)를 ccrc 폴더에 내려받는다. 배포판에 따라 npm 은 Node.js 와 다른 패키지다.
  - root 가 필요한 것은 기본 도구, Tailscale, 그리고 시스템이 요구할 때의 `loginctl enable-linger` 뿐이다.

## 설치

평소 쓰는 사용자로 실행한다(root 나 sudo 로 실행하지 않는다).

```bash
curl -fsSL https://raw.githubusercontent.com/rjs0429/ccrc/main/install.sh | bash
```

실행하기 전에 스크립트를 읽어 보거나 버전을 고르려면 이렇게 한다.

```bash
curl -fsSLO https://raw.githubusercontent.com/rjs0429/ccrc/v0.7.0/install.sh
less install.sh
bash install.sh --version v0.7.0
```

`install.sh` 는 준비만 하고 나머지는 `ccrc setup` 에 넘긴다.

1. 플랫폼(리눅스, x86_64 또는 aarch64, systemd 사용자 세션)을 확인한다. root 로 실행하면 멈춘다.
2. 빠진 기본 도구(git, curl, tar, xz, sha256sum, ssh-keygen)를 apt, dnf, pacman, zypper 로 설치한다. sudo 를 쓰므로 이유를 말하고 먼저 묻는다. `--yes` 를 줘도 묻는다([sudo](#sudo) 참고). `ssh-keygen` 만 빠졌고 끝내 설치되지 않으면(sudo 를 허락하지 않음, `--no-system`, 패키지 관리자 없음, 설치 실패) 경고하고 설치를 계속한다. 설치에는 쓰지 않기 때문이다. 대신 `ccrc update` 는 `ssh-keygen` 이 설치될 때까지 서명 확인에서 이유를 말하고 멈춘다.
3. Node.js 22.18 이상을 찾는다(`CCRC_NODE`, ccrc 폴더의 Node, 이전 설치가 기록한 Node, `PATH` 순서). 없으면 nodejs.org 에서 최신 Node.js 22 를 내려받아 그곳의 `SHASUMS256.txt` 로 확인하고, `~/.local/share/ccrc/node-v22.x.y-linux-<arch>` 에 풀어 `~/.local/share/ccrc/node` 로 링크한다. 체크섬은 망가지거나 잘린 내려받기를 잡아낸다. 파일이 Node.js 의 것인지는 출처와의 HTTPS 연결에 기댄다(`SHASUMS256.txt` 의 서명은 확인하지 않는다).
4. 릴리스를 `~/.local/share/ccrc/versions/<version>` 에 clone 하고 거기서 `npm ci` 와 `npm run build` 를 돌린다. 설치 내용을 `.ccrc-install.json` 에 기록하고 `~/.local/share/ccrc/current` 와 `~/.local/bin/ccrc` 를 링크한다. 여기서는 태그 서명을 확인하지 않는다(손으로 확인하려면 [릴리스 확인하기](#릴리스-확인하기) 참고). `ccrc update` 는 올라가는 태그마다 서명을 확인하고, 그 버전이 이미 `versions/` 에 있어도 확인한다.
5. `ccrc setup` 을 돌린다. `curl | bash` 로 실행하면 질문은 터미널(`/dev/tty`)에서 읽는다.

기록은 `~/.local/state/ccrc/install.log` 에 남는다. 단계가 실패하면 안내대로 고치고 스크립트를 다시 돌린다. 끝난 단계는 그대로 둔다. 이미 설치된 곳에서 다시 돌리면 설치된 버전을 그대로 두고(버전을 바꾸려면 `ccrc update`) setup 만 다시 돌린다.

| `install.sh` 옵션 | 뜻 |
|---|---|
| `--version <tag>` | 최신 릴리스 대신 이 릴리스를 설치한다(`0.7.0` 과 `v0.7.0` 모두 태그 `v0.7.0` 을 가리킨다) |
| `--channel stable\|rc` | `rc` 면 최신 릴리스를 찾을 때 릴리스 후보도 센다 |
| `--yes` | sudo 를 쓸지 묻는 질문 말고는 모든 질문에 기본 답을 고른다. 사용자가 해야 하는 단계는 그래도 기다린다. 단 `devices` 는 휴대폰이 정확히 하나일 때만 그것을 추가하고, 휴대폰을 기다리지 않는다 |
| `--allow-sudo` | 터미널이 없을 때 sudo 가 필요한 단계를 돌게 한다. 이때 sudo 는 비밀번호를 묻지 않고 동작해야 한다. 터미널이 있으면 그래도 하나하나 묻는다. `ccrc setup` 에도 넘긴다 |
| `--dry-run` | 무엇을 할지 보여 주기만 하고 아무것도 바꾸지 않는다. 설치된 것이 있으면 setup 부분도 보여 준다 |
| `--no-system` | sudo 를 쓰거나 시스템을 바꾸지 않는다(시험용) |
| `--uninstall` | 설치된 ccrc 의 `ccrc uninstall` 을 돌린다 |
| `--ref <git ref>`, `--from <path>` | 브랜치나 커밋, 또는 로컬 저장소에서 설치한다(시험용) |
| 그 밖의 옵션과 `--` 뒤의 모든 것 | `ccrc setup` 에 넘긴다. 예: `bash install.sh -- --https-port 8444 --no-vscode` |

`install.sh` 가 읽는 환경 변수는 `CCRC_REPO_URL`(설치할 저장소), `CCRC_DATA_DIR`, `CCRC_STATE_DIR`, `CCRC_NODE`(찾는 대신 쓸 Node.js 22.18 이상), `CCRC_NODE_DIST`(Node.js 를 내려받을 곳, 미러용)다.

### `ccrc setup` 이 하는 일

setup 은 단계마다 확인하고 빠진 것만 한다. 그래서 다시 돌리면 설치를 마저 끝내거나 고친다. 사용자가 해야 하는 단계는 할 일을 보여 주고 끝날 때까지 기다린다(`--yes` 면 `devices` 는 기다리지 않는다. 그 행 참고). VS Code 설정을 바꾸는 것은 맨 먼저 묻는다. `--yes` 는 이 질문과 다른 질문에 기본 답을 고른다. sudo 가 필요한 단계는 따로 묻는다([sudo](#sudo) 참고).

| 단계 id | 확인하고 하는 일 |
|---|---|
| `ssh-keygen` | OpenSSH 의 `ssh-keygen` 이 `PATH` 에 있고 OpenSSH 8.2 이상인지 본다. `ccrc update` 가 릴리스 서명을 확인할 때 필요하다. git 이 `ssh-keygen` 에 묻는 것을 setup 도 똑같이 묻고, `-Y find-principals` 가 없으면 더 옛 버전으로 본다. 없거나 옛 버전이면 업데이트가 그 확인에서 멈춘다고 경고하고 고치는 법을 보여 준다: 찾은 패키지 관리자로 설치하는 명령, 또는 더 새 OpenSSH. 아무것도 설치하지 않고(sudo 없음) 다음 단계로 넘어간다. ccrc 를 체크아웃에서 돌리면 건너뛴다 |
| `claude` | Claude Code 확장이나 CLI 가 설치되고 로그인돼 있는지 본다(`claude auth status`). 아니면 `code --install-extension` 으로 확장을 설치할지 묻거나 방법을 보여 주고, 로그인을 기다린다 |
| `tailscale-install` | Tailscale 이 설치되고 돌고 있는지 본다. 아니면 Tailscale 설치 스크립트를 돌린다(sudo) |
| `tailscale-login` | 이 컴퓨터가 로그인돼 있는지 본다. 아니면 옵션 없이 `sudo tailscale up` 을 돌린다. 그래서 컴퓨터에 있던 Tailscale 설정이 그대로 남는다. 보여 주는 로그인 링크를 사용자가 여는 동안 기다린다 |
| `tailscale-operator` | `tailscale serve` 가 sudo 없이 되는지 본다. 아니면 `sudo tailscale set --operator=$USER` |
| `https` | MagicDNS 와 HTTPS 인증서가 켜져 있는지 본다. 아니면 그것을 켜는 Tailscale 관리 페이지를 보여 주고 기다린다. 켜면 컴퓨터 이름이 공개 인증서 로그에 남는다 |
| `devices` | 이 컴퓨터가 속한 Tailscale 사용자(`tailscale status --json` 의 `UserID`)의 iOS·Android 기기를 `allowedDevices` 후보로 보여 준다. tailnet 의 다른 사용자 휴대폰은 보여 주지 않는다. `--yes` 면 내 휴대폰이 정확히 하나일 때만 그것을 추가하고, 아니면 아무것도 추가하지 않고 내 휴대폰을 추가하는 법을 알려 준다. 태그가 붙은 컴퓨터나 사용자를 알려 주지 않는 Tailscale 에서는 후보가 없다. 이때는 `ccrc config set allowedDevices '["phone"]'` 처럼 이름을 적는다. config.json 에 이미 목록이 있으면 그대로 둔다 |
| `account` | ccrc 로그인 ID 와 비밀번호를 정한다(`ccrc passwd`) |
| `config` | 새 세션을 시작할 수 있는 폴더를 묻고(기본은 홈. `none` 이면 이미 세션이 있는 폴더만), `claudePath` 를 정하고, 브로커 세션의 로그인 방식을 묻는다(`off`, 키를 가려서 입력하는 `apiKey`, `subscription`). config.json 에 이미 있는 설정은 그대로 둔다. 빈 `roots` 목록도 그대로 둔다 |
| `service` | `~/.config/systemd/user/ccrc.service` 를 쓰고(찾은 Node 로 `<dataDir>/current/bin/ccrc serve` 를 돌린다), 켜서 시작한 뒤 `/api/ping` 을 확인한다. 바꾸는 유닛은 먼저 백업하고, setup 이 직접 쓰지 않는 `Environment` 줄(프록시 등)은 그대로 둔다. linger 는 선택이다. 꺼져 있으면 로그아웃한 동안에도 브로커가 돌도록 켤지 묻는다(`--yes` 면 꺼 둔다). 브로커 세션 안에서는 돌지 않는다([업데이트와 되돌리기](#업데이트와-되돌리기) 참고) |
| `serve` | `tailscale serve --bg --https=8443 http://127.0.0.1:8737` 을 걸고(다시 시작해도 남는다) 휴대폰에서 열 주소를 보여 준다 |
| `vscode` | 묻고, 백업한 뒤 VS Code 의 `settings.json` 에 `claudeCode.claudeProcessWrapper` 를 넣는다. 주석과 배치는 그대로 둔다 |
| `phone` | 주소(`qrencode` 가 있으면 터미널 QR 코드도)와 휴대폰에서 할 일을 보여 준다 |
| `doctor` | 모델을 부르지 않고 VS Code 의 Claude Code 와 호환되는지 점검한다 |

```
ccrc setup [--yes] [--allow-sudo] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]
```

`--only` 와 `--skip` 은 쉼표로 나눈 단계 id 를 받는다. `--no-system` 은 sudo 를 쓰거나 시스템을 바꾸는 단계(Tailscale, 서비스, `tailscale serve`)를 뺀다. `--allow-sudo` 는 터미널 없이도 sudo 가 필요한 단계를 돌게 한다([sudo](#sudo) 참고). `--https-port` 는 tailnet HTTPS 포트를 정한다(기본 8443).

브로커는 처음 시작할 때, 예전 브로커 세션이 `~/.claude/projects` 아래에 쓴 대화 기록의 `entrypoint` 필드를 고쳐 쓴다. 그래야 VS Code 가 그 세션을 목록에 보여 준다. 고치기 전에 파일마다 `~/.local/state/ccrc/backup/` 에 복사해 둔다. 새로 설치했다면 고칠 것이 없다.

#### sudo

`install.sh` 와 `ccrc setup` 은 기본 도구, Tailscale(`tailscale-install`, `tailscale-login`, `tailscale-operator`), 그리고 시스템이 sudo 없이는 거부할 때의 `loginctl enable-linger` 에만 sudo 를 쓴다. sudo 동의는 `--yes` 로 대신하지 않는다.

- 터미널이 있으면 쓸 때마다 무엇을 왜 실행하는지 말하고 묻는다. `--allow-sudo` 가 있어도 같다.
- 터미널이 없으면(스크립트에서 돌릴 때 등) `--allow-sudo` 가 있을 때만 돌린다. 이때 sudo 는 비밀번호를 묻지 않고 동작해야 한다(예: `NOPASSWD` 규칙). 아니면 그 sudo 가 실패하고 단계도 실패한다. `--allow-sudo` 가 없으면 `install.sh` 는 기본 도구를 설치하기 전에 멈춘다. setup 은 그 단계를 "sudo consent needed" 로 남기고, 그 단계와 상관없는 단계를 계속한 뒤 마무리하는 법을 알려 준다: 터미널에서 `ccrc setup` 을 돌리거나, `--allow-sudo` 를 붙여 다시 돌린다.
- 0.7.1 전에는 setup 이 `--yes` 를 sudo 동의로 받았고 `--allow-sudo` 가 없었다. `install.sh` 가 그런 버전(`--version v0.7.0`)을 `--yes` 와 함께, `--allow-sudo` 없이 설치하면 그 setup 을 `--yes` 없이 돌린다. 그래서 질문마다 묻고, 터미널이 없으면 코드를 설치한 뒤 멈춘다.
- `--no-system` 은 이 단계들을 아예 뺀다. `deploy/install-service.sh`(`ccrc setup --only service --yes`)는 sudo 를 쓰지 않는다. `--yes` 이므로 linger 는 있는 그대로 둔다.

### 휴대폰에서

1. Tailscale 앱을 설치하고 컴퓨터와 같은 Tailscale 계정으로 로그인한다.
2. setup 이 보여 준 주소(`https://<machine>.<tailnet>.ts.net:8443`)를 Safari 로 열고 ccrc ID 와 비밀번호로 로그인한다.
3. 공유 > 홈 화면에 추가를 누른 뒤, 홈 화면의 ccrc 를 연다.
4. ccrc 의 설정 > 알림과 입력에서 "알림 켜기"를 누르고 "테스트 알림 보내기"로 확인한다(iOS 16.4 이상. iOS 는 홈 화면 앱에서만 웹 푸시를 허용한다).
5. 원하면 계정과 보안에서 패스키를 등록한다. 그러면 원격 로그인을 시작할 때와 `passkeyHours`(기본 18시간)마다 Face ID(또는 휴대폰 암호)로 확인한다. 다른 휴대폰이나 태블릿은 처음 로그인할 때 자기 패스키를 등록한다. [보안 모델](#보안-모델) 참고.

앱은 휴대폰 언어를 따른다. 휴대폰의 첫 번째 언어가 한국어면 한국어, 아니면 영어다. 설정 > 언어 / Language 에서 한쪽으로 정할 수 있다. 고른 언어는 휴대폰에 저장되므로 로그인 화면도 따른다. 휴대폰으로 오는 알림과 휴대폰에서 내보낸 대화도 같은 언어로 쓴다.

iOS 는 알림으로 앱을 열면서 알림이 가리키는 곳으로 가지 않을 때가 있다. 아직 답을 기다리는 요청의 알림이 온 지 2분 안에 앱이 앞으로 나왔는데 알림 탭이 앱에 닿지 않았다면, 앱이 스스로 그 요청으로 간다. 요청마다 한 번만 그렇게 하고, 새 세션 초안에서는 하지 않는다. 알림 탭이 앱에 닿으면 그 탭이 갈 곳을 정한다.

알림은 앱 아이콘이 그 세션을 아직 셀 때만 남는다. 턴 끝, Claude 가 보낸 알림, 보낸 파일, 복사본의 첫 메시지 알림은 세션을 읽을 때까지(휴대폰에서 열거나 VS Code 에서 그 세션에 메시지를 보낼 때까지), 요청 알림은 답할 때까지 남는다. 나머지 알림은 휴대폰이 닫는다. 앱이 앞으로 나올 때, 세션을 열 때, 목록이 바뀌었다고 들을 때, 다음 알림이 올 때 닫는다. 같은 세션의 같은 종류 알림은 새것이 옛것을 대신한다. 앱이 닫혀 있는 동안에는 휴대폰에 다른 신호가 가지 않는다. 그래서 VS Code 에서 읽은 세션도 그때까지 알림이 남고, 아이콘 숫자도 남는다. 설정의 "알림 끄기"와 로그아웃은 앱의 알림을 모두 닫는다. iOS 26.5 이상은 알림이 보인 지 30초 안에는 닫지 않는다. 그래서 앱이 앞에 있는 동안 30초가 지나면 다시 닫아 본다.

Android 의 Chrome 도 같은 방식으로 될 것이지만 시험하지 않았다.

### VS Code

setup 은 VS Code 사용자 설정에 한 줄을 넣는다.

```json
"claudeCode.claudeProcessWrapper": "/home/user/.local/share/ccrc/current/bin/ccrc-wrapper"
```

그 뒤에 연 Claude Code 탭은 ccrc 를 거친다. 이미 열린 탭은 닫았다 다시 열 때까지(또는 창을 다시 불러올 때까지) ccrc 없이 돈다. 래퍼는 대화 프로세스만 중계한다. 그 밖의 것(설정 조회, `auth status`, worktree 정리)은 Claude Code 를 바로 돌린다. 브로커가 꺼져 있어도 VS Code 는 똑같이 동작하고, 브로커가 돌아오면 래퍼가 다시 연결한다.

- 권한 요청은 VS Code 와 휴대폰에 함께 뜬다. 먼저 한 답이 쓰인다.
- 브로커가 돌리는 세션을 VS Code 에서 열면 VS Code 로 넘어간다. 다른 VS Code 탭에서 쉬고 있는 세션은 새 탭으로 옮겨 간다. 그 탭의 Claude Code 는 탭을 닫을 때처럼 끝나고, 두 탭 모두 대화 아래 한 줄로 이를 알린다. 옛 탭에서 메시지를 보내면 세션이 다시 그쪽으로 옮겨 간다. 탭이 답하는 중이거나, 사용자를 기다리거나, 아직 받아들이지 않은 메시지가 있거나, 백그라운드 작업을 돌리거나, 그 탭에 예약된 작업(CronCreate, ScheduleWakeup)이 있는 동안에는 탭이 세션을 내주지 않는다.
- 다른 프로세스가 아직 쥐고 있는 세션(그런 탭, 터미널, 백그라운드 세션, ccrc 래퍼가 없거나 옛 래퍼인 탭)은 최대 9초 기다린 뒤 VS Code 에서 복사본으로 열린다. 두 프로세스가 한 대화 기록에 같이 쓰지 않게 하려는 것이다. 탭은 어떤 종류의 프로세스가 원본을 쥐고 있는지, 여기서 보낸 메시지는 원본에 닿지 않는다는 것을 알린다. 복사본 이름은 "(복사본) <제목>" 이다(영어로는 "(copy)". 복사본의 복사본은 "(복사본 2)" 처럼 이어서 센다). 휴대폰은 복사본이 첫 메시지를 받을 때 한 번 알림을 받고, 활동 기록은 옮겨 간 것과 복사본을 구별한다. 이 안내 줄은 휴대폰 알림의 언어로 쓴다. 알림을 구독한 휴대폰이 없으면 컴퓨터 로캘의 언어로 쓴다.
- 래퍼를 설정하면 확장은 두 가지 기능을 끈다. 래퍼가 그 둘을 대신 한다. 창을 다시 불러와 끊긴 턴을 이어 가고(한 시간 안에 두 번까지. `claudeCode.continueAfterReload: false` 로 끈다), 새 탭을 VS Code 가 기억한 권한 모드로 시작한다.
- Claude 가 알림을 보내면(PushNotification 도구) ccrc 가 휴대폰으로 보낸다. 래퍼는 확장의 `initialize` 에 PostToolUse 훅 하나를 더하고, 그 훅에는 직접 답한다. 이 알림을 받는 휴대폰이 있으면 Claude 는 Claude Code 의 "not sent" 대신 "Mobile push requested." 를 읽고, 휴대폰이 그 세션을 보고 있으면 알림이 필요 없었다는 답을 읽는다. 그 호출의 다른 것은 바뀌지 않고, VS Code 자신의 훅도 전처럼 VS Code 에 닿는다. 옛 래퍼로 연 탭도 알림은 보내지만, Claude 는 Claude Code 의 원래 답을 읽는다.
- VS Code 에서 ccrc 를 끄려면 설정을 지우거나 `claudeCode.environmentVariables` 에 `CCRC_WRAPPER=off` 를 넣는다.
- `vscodeArchive` 를 켜면(휴대폰에서는 설정 > 알림과 입력 > 세션 목록의 "VS Code에서 보관한 세션도 보관으로 보기"), 확장이 보관한 세션을 ccrc 목록에서도 보관으로 세고 "VS Code 보관" 표시를 붙인다. 손으로 보관한 세션과, `claudeCode.archiveInactiveSessions` 일(기본 14일) 동안 쓰지 않아 보관된 세션이 모두 들어간다. ccrc 는 확장의 목록을 VS Code 상태 데이터베이스(`~/.config/Code/User/globalStorage/state.vscdb`, 기본 프로필만)에서 읽기만 하고 쓰지 않는다. 그래서 그런 세션을 휴대폰에서 다시 꺼내도 VS Code 에서는 보관된 채로 남는다.

### 다른 곳에서 연 세션

터미널, 백그라운드(`claude --bg`), `claude -p` 나 다른 프로그램, 래퍼를 설정하기 전에 연 VS Code 탭에서 연 세션은 대화 기록이 늘어나는 대로 휴대폰에 보인다. Claude Code 2.1.224 이상은 이런 세션마다 내 다른 세션의 메시지를 받는 수신 소켓을 두고, 휴대폰은 거기로 글을 보낸다.

- Claude 는 이 글을 사용자가 아닌 다른 세션("ccrc 휴대폰")이 보낸 메시지로 받는다. 그 세션 자신의 권한 안에서 움직이고, 중요한 일 앞에서는 그 세션에서 묻는다. 글 안의 "/" 명령은 실행하지 않고, 기다리는 요청에 답하지도 않는다.
- 권한 요청을 건너뛰는 세션은 메시지를 보류한다. 터미널은 그 터미널에서 묻는다. 백그라운드 세션도 `claude agents` 에서 열면 묻는다(목록에 권한 요청을 기다리는 것으로 나온다). 그 밖의 곳에서는 5분 안에 모드가 바뀌지 않으면 버린다. 사용자 설정이나 프로젝트 설정에 `crossSessionInbound` 가 있으면 그 설정이 대신 정한다. 휴대폰은 대화 기록의 마지막 권한 모드와 그 설정으로 알 수 있는 만큼을 보내기 전에 알려 준다.
- 첨부, 모델과 모드 바꾸기, 턴 중지, 그 세션의 요청에 답하기는 그 세션을 돌리는 프로그램에 남는다. 등록 정보에 ccrc 가 아는 것(`peerProtocol` 1)과 다른 수신 형식을 적은 세션은 보기만 된다.

## 업데이트와 되돌리기

브로커는 시작하고 1분 뒤, 그 뒤로는 하루 한 번 새 릴리스를 찾는다(`git ls-remote`. GitHub API 는 쓰지 않는다). 새 버전은 휴대폰 설정(상태와 점검)과 `ccrc status` 에 보인다. 설치본(개발용 체크아웃이 아닌 것)에서는 알림을 켠 휴대폰이 새 릴리스마다 알림을 한 번 받는다. 업데이트는 컴퓨터의 터미널이나 VS Code 터미널에서 적용한다.

```bash
ccrc update --check        # 알리기만 한다
ccrc update                # 내 채널의 최신 릴리스
ccrc update --to v0.7.1    # 정한 버전, 더 새것이든 옛것이든
ccrc rollback              # 마지막 업데이트 전 버전으로
```

`ccrc update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repository>[@<ref>]]`:

1. 최신 릴리스 태그를 찾는다(릴리스 후보는 `--channel rc` 나 `updateChannel: "rc"` 일 때만 센다).
2. 그 태그를 `versions/<version>` 에 받고, `CHANGELOG.md` 의 그 버전 절을 보여 준 뒤(호환성이 깨지는 변경은 따로) 진행할지 묻는다. 0.7.2 부터 설치본에는 `.ccrc-allowed-signers` 가 있고, 태그의 SSH 서명이 그 파일과 맞아야 한다(`git verify-tag`). [릴리스 확인하기](#릴리스-확인하기) 참고. `versions/<version>` 에 이미 있는 사본(`install.sh` 나 이전 업데이트가 남긴 것)은 같은 확인을 통과할 때만 쓰고, 아니면 다시 받는다.
3. 돌고 있는 버전 옆에서 빌드한다(`npm ci`, `npm run build`). 그동안 서비스는 계속 돈다.
4. 설정과 상태를 `~/.local/state/ccrc/backup/update-<old>-<new>-<time>/` 에 백업하고, 새 버전의 코드로 옮긴다(migrate).
5. 전환을 `~/.local/share/ccrc/history.json` 에 기록하고, `current` 링크를 옮기고, `ccrc.service` 를 다시 시작한 뒤 `/api/ping` 이 새 버전을 알릴 때까지 최대 30초 기다린다.
6. 알리지 않으면 링크를 되돌리고, 백업을 복원하고, 옛 버전을 다시 시작한 뒤 종료 코드 3 으로 끝난다.
7. 이전 버전은 남기고(열린 VS Code 탭이 아직 그 래퍼를 쓸 수 있다) 더 오래된 버전은 지운다.
8. 더 할 일을 알려 준다. 래퍼 프로토콜이 바뀌었거나 새 래퍼에 새 기능이 있으면(기능 이름을 알려 준다) VS Code 창을 다시 불러오고, 휴대폰의 홈 화면 앱을 완전히 닫았다 다시 연다. 이 안내는 업데이트하기 전 버전이 한다. 0.7 은 프로토콜 변경만 알려 주므로 [변경 기록](CHANGELOG.ko.md#07-에서-업데이트할-때)의 "0.7 에서 업데이트할 때"를 본다.

`ccrc update`, `ccrc rollback`, setup 의 `service` 단계, `ccrc uninstall` 은 브로커 세션 안에서는 돌지 않는다(예: 휴대폰에서 Claude 에게 실행을 시킬 때). 그런 세션은 `ccrc.service` 안에서 돌기 때문에, 서비스를 다시 시작하면 명령이 새 버전을 확인하거나 되돌리기 전에 중간에서 멈춘다.

종료 코드: 0 끝남 또는 할 일 없음, 1 아무것도 바꾸기 전에 멈춤, 3 업데이트가 실패해 옛 버전으로 돌아감, 4 되돌린 뒤 옛 버전을 확인하지 못함(`systemctl --user status ccrc.service` 를 확인한다). `ccrc rollback` 은 서비스를 다시 시작하지 못하면 4 로 끝난다.

`ccrc rollback` 은 마지막 업데이트 전 버전으로 돌아가고, 그 업데이트의 migrate 가 바꿨다고 알린 설정·상태 파일만 되돌린다(지금 파일은 먼저 백업한다). 그래서 그 뒤에 바꾼 비밀번호와 알림 구독은 남는다. 전환을 확인하는 동안에는 Ctrl-C 를 미뤄 두므로, 중간에 끊긴 실행도 되돌릴 수 있다. 0.7.x 로 돌아가면 패스키 확인이 꺼진다. 0.7 은 `passkeys.json` 을 읽지 않아 비밀번호만으로 로그인된다. 패스키는 남아 있으므로 다시 업데이트하면 확인이 돌아온다.

버전은 `install.sh --version` 이 아니라 `ccrc update` 로 바꾼다. `install.sh` 는 전환을 `history.json` 에 기록하지 않아 `ccrc rollback` 으로 되돌릴 수 없다.

`ccrc update --from <repository>[@<ref>]` 는 로컬 저장소의 커밋을 같은 방식으로 한 버전(이름은 `git describe`)으로 설치한다. 릴리스 전에 바뀐 것을 시험할 때 쓴다. 설치본은 그 뒤에도 전에 찾던 곳에서 릴리스를 찾는다. 개발용 체크아웃에서 `ccrc update` 는 이 방법을 설명만 한다. `--check` 는 거기서도 된다.

## 제거

```bash
ccrc uninstall [--purge] [--yes] [--dry-run]
```

이 순서로 지운다. VS Code 설정에서 `claudeCode.claudeProcessWrapper` 를 지우고(백업한 뒤. 래퍼가 먼저 사라지면 VS Code 가 Claude Code 를 띄우지 못한다), `ccrc.service` 를 멈추고 지우고, 그 `tailscale serve` 를 끄고, 설치된 버전이 든 `~/.local/share/ccrc` 와 `~/.local/bin/ccrc` 링크를 지운다. `--purge` 는 설정(`~/.config/ccrc`)과 상태(`~/.local/state/ccrc`, 백업 포함)도 지운다. 이때 VS Code 설정의 백업은 `settings.json` 옆에 남긴다. Tailscale, 시스템의 Node.js, Claude Code 는 건드리지 않는다.

- 설치본을 가리키는 VS Code 설정이나 서비스만 지운다. 개발용 체크아웃을 돌리고 있어서 남긴 것이 있으면 `~/.local/share/ccrc/node` 도 남긴다. 그 체크아웃이 거기서 Node.js 를 찾기 때문이다.
- `/`, 홈 폴더, `~/.config`, `~/.local`, `~/.local/share`, `~/.local/state`, `~/.cache`(또는 대신 정한 `XDG_*` 폴더), 이 중 하나를 품은 폴더는 절대 건드리지 않는다.
- 폴더를 통째로 지우는 것은 이름이 `ccrc` 일 때뿐이다. 다른 이름의 폴더(`CCRC_DATA_DIR`, `CCRC_CONFIG_DIR`, `CCRC_STATE_DIR` 를 그곳으로 정한 경우)에서는 ccrc 가 만드는 파일과 폴더만 지운다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `ccrc serve` | 브로커를 돌린다(서비스가 돌리는 것) |
| `ccrc setup [options]` | 설정의 각 부분을 확인하고 빠진 것을 한다(`ccrc setup --help`) |
| `ccrc passwd` | 로그인 ID 와 비밀번호를 정한다 |
| `ccrc status` | 버전, 설정 파일, 듣는 주소, 래퍼 소켓, 허용 기기, 최신 릴리스, 브로커 세션, 로그인, 현재 원격 사용, 패스키 |
| `ccrc logout` | 현재 원격 로그인을 끝낸다 |
| `ccrc passkey [list \| remove <id> \| reset [--yes]]` | 휴대폰들의 패스키를 보여 주거나, id 앞부분으로 하나를 지우거나, 모두 지운다(휴대폰의 패스키를 잃었을 때). 모두 지우면 휴대폰이 다시 등록할 때까지 원격 로그인은 비밀번호만으로 확인한다 |
| `ccrc version`, `ccrc --version` | 버전. 설치된 릴리스, 체크아웃이면 `git describe`, 아니면 package.json 의 버전 |
| `ccrc config path` | config.json 의 위치 |
| `ccrc config get [key]` | 설정 전체, 또는 키 하나 |
| `ccrc config set <key> <value>` | 키를 바꾼다. JSON 이 아닌 값은 문자열로 받는다. 모르는 키는 거부한다 |
| `ccrc config set-api-key` | `brokerSessions: "apiKey"` 에 쓸 Anthropic API 키를 저장한다(가려서 입력하거나 stdin 으로) |
| `ccrc migrate` | config.json 을 이 버전의 형식으로 바꾼다(`serve` 도 한다) |
| `ccrc update [...]`, `ccrc rollback [--yes]` | [업데이트와 되돌리기](#업데이트와-되돌리기) 참고 |
| `ccrc uninstall [...]` | [제거](#제거) 참고 |
| `ccrc-wrapper` | VS Code `claudeCode.claudeProcessWrapper` 의 값. 손으로 돌리지 않는다 |

`GET /api/ping` 은 로그인 없이 `{ "ok": true, "version": "..." }` 로 답한다. 이 컴퓨터와 허용된 기기에만 답한다.

## 설정

설정 파일은 `~/.config/ccrc/config.json` 이다. `ccrc config set` 으로 바꾸거나 파일을 직접 고친다. 파일은 읽을 때 검사한다. 키의 형식이 틀리면 그 키와 받는 형식을 알리고 브로커가 멈춘다. 깨진 JSON 은 줄과 열을 알린다. 모르는 키는 경고만 한다. 돌고 있는 브로커는 바뀐 것을 바로 반영한다. 단 `host`, `port`, `claudePath` 는 다시 시작해야 한다(`systemctl --user restart ccrc.service`).

| 키 | 기본값 | 뜻 |
|---|---|---|
| `schemaVersion` | `1` | 파일 형식. ccrc 가 쓴다. 옛 파일은 `~/.local/state/ccrc/backup/migrate-<from>-<to>-<time>/` 에 백업한 뒤 옮긴다. 더 새 ccrc 가 쓴 파일은 거부하고, 업데이트하거나 되돌리라고 알린다 |
| `brokerSessions` | `"off"` | ccrc 가 직접 띄우는 세션의 로그인 방식: `"off"`, `"apiKey"`, `"subscription"`([위](#휴대폰이-띄우는-세션의-로그인-방식-brokersessions) 참고). 0.6 이하의 설정은 `"subscription"` 이 된다 |
| `allowedDevices` | `[]` | `tailscale serve` 로 들어올 수 있는 tailnet 기기. 내 tailnet 의 MagicDNS 이름 첫 부분으로 적는다(`phone.<tailnet>.ts.net` 이면 `"phone"`. 기기가 알리는 호스트 이름이 아니다) |
| `allowLocal` | `true` | 이 컴퓨터 자신의 요청을 허용한다 |
| `roots` | `[]` | 이미 세션이 있는 폴더 말고도 새 세션을 시작할 수 있는 폴더(하위 폴더 포함) |
| `claudePath` | `"vscode"` | 브로커 세션에 쓸 Claude Code CLI. 경로, 또는 `"vscode"`(가장 새 VS Code 확장에 든 CLI. 세션을 시작할 때마다 다시 고른다). 그것이 없으면 `~/.local/bin/claude`, 그것도 없으면 Agent SDK 에 딸린 CLI |
| `leaseIdleMinutes` | `720` | 이만큼 활동이 없으면 원격 로그인이 끝난다 |
| `sessionIdleMinutes` | `15` | 아무도 보지 않고, 할 일도 열린 요청도 없는 브로커 세션 프로세스는 이만큼 지나면 닫는다 |
| `host` | `"127.0.0.1"` | 브로커가 듣는 주소(루프백으로 둔다. 휴대폰은 `tailscale serve` 를 거쳐 들어온다) |
| `port` | `8737` | 브로커가 듣는 포트 |
| `updateCheck` | `true` | 시작하고 1분 뒤, 그 뒤로 하루 한 번 새 릴리스를 찾는다 |
| `updateChannel` | `"stable"` | `"stable"`, 또는 릴리스 후보도 포함하는 `"rc"` |
| `updateRepo` | (없음) | 설치본이 출처를 적지 않았을 때 찾아볼 저장소. 없으면 `https://github.com/rjs0429/ccrc.git` |
| `updateNotify` | `true` | 새 릴리스마다 구독한 휴대폰에 푸시 알림을 한 번 보낸다 |
| `vscodeArchive` | `false` | VS Code 의 Claude Code 확장이 보관한 세션을 ccrc 목록에서도 보관으로 센다([VS Code](#vs-code) 참고). 휴대폰에서도 바꿀 수 있다 |
| `passkeyHours` | `18` | 휴대폰이 패스키를 등록하면, 원격 로그인을 시작할 때와 이 시간이 지날 때마다 패스키로 확인한다. 이 컴퓨터에서 하는 로그인은 묻지 않는다 |

그 밖의 설정(알림, Enter로 보내기, 앱 언어, 휴대폰에 저장하는 최근 대화, Claude Code 자체 설정)은 휴대폰 설정 화면에서 바꾼다.

### 환경 변수

| 변수 | 뜻 |
|---|---|
| `CCRC_CONFIG_DIR` | 설정 폴더(기본 `$XDG_CONFIG_HOME/ccrc`, 곧 `~/.config/ccrc`) |
| `CCRC_STATE_DIR` | 상태 폴더(기본 `$XDG_STATE_HOME/ccrc`, 곧 `~/.local/state/ccrc`) |
| `CCRC_DATA_DIR` | 설치 폴더(기본 `$XDG_DATA_HOME/ccrc`, 곧 `~/.local/share/ccrc`) |
| `CCRC_NODE` | `ccrc` 와 래퍼가 쓸 Node.js 22.18 이상. `<dataDir>/node/bin/node`, 설치본이 기록한 Node, `PATH` 보다 먼저 본다. setup 은 이 값을 서비스 유닛에 써 두는데, 그 값은 서비스만 읽는다. 래퍼는 VS Code 자신의 환경(또는 `claudeCode.environmentVariables`)에 있을 때만 본다 |
| `CCRC_VSCODE_EXTENSIONS_DIR` | VS Code 확장 폴더(기본 `~/.vscode/extensions`) |
| `CLAUDE_CONFIG_DIR` | Claude Code 폴더(기본 `~/.claude`). ccrc 는 모든 곳에서 이것을 따른다 |
| `CCRC_WRAPPER=off` | `claudeCode.environmentVariables` 에 넣으면 VS Code 가 ccrc 없이 Claude Code 를 돌린다 |
| `CCRC_SEND_FILES=0` | ccrc 의 세션에서 Claude Code 의 파일 보내기(`CLAUDE_CODE_ATTACHMENTS_BY_PATH`)를 켜지 않는다 |
| `CCRC_LINK_SOCKET` | 래퍼와 브로커가 만나는 소켓(기본 `$XDG_RUNTIME_DIR/ccrc/link.sock`) |
| `CCRC_WRAPPER_LOG` | 래퍼 로그 파일(기본 `<stateDir>/wrapper.log`) |
| `CCRC_LOG_LEVEL` | 브로커 요청 로그 수준(기본 `info`. 서비스 유닛은 `warn` 으로 둔다) |
| `CCRC_REPO_URL`, `CCRC_NODE_DIST` | `install.sh` 전용: 설치할 저장소와 Node.js 를 내려받을 곳 |

setup 이 돌 때 `CCRC_CONFIG_DIR`, `CCRC_STATE_DIR`, `CCRC_DATA_DIR`, `CLAUDE_CONFIG_DIR`, `CCRC_VSCODE_EXTENSIONS_DIR` 가 정해져 있으면 서비스 유닛에도 써 둔다.

## 파일과 폴더

| 경로 | 담는 것 |
|---|---|
| `~/.local/share/ccrc/versions/<version>/` | 설치된 버전들(빌드 결과와 `.ccrc-install.json` 이 든 git 사본) |
| `~/.local/share/ccrc/current` | 돌고 있는 버전으로 가는 링크. 서비스와 VS Code 는 이 링크를 거친 경로를 쓴다 |
| `~/.local/share/ccrc/node` | `install.sh` 가 (필요해서) 내려받은 Node.js. 개발용 체크아웃에서는 `ccrc` 와 래퍼가 Node.js 를 찾도록 직접 만드는 Node.js 폴더 링크 |
| `~/.local/share/ccrc/history.json` | 업데이트와 되돌리기 기록. 각각의 백업 폴더도 적는다 |
| `~/.local/bin/ccrc` | `current/bin/ccrc` 로 가는 링크 |
| `~/.config/ccrc/config.json` | 설정 |
| `~/.config/ccrc/state.json` | 로그인 ID, Argon2id 비밀번호 해시, 현재 로그인, 잠금 |
| `~/.config/ccrc/push.json` | Web Push 키와 구독 |
| `~/.config/ccrc/passkeys.json` | 휴대폰들의 패스키: 자격 증명 id 와 공개 키, 각 패스키를 만든 호스트 이름, 등록한 기기, 등록한 때와 마지막으로 쓴 때. 비밀은 없다. 첫 패스키를 등록할 때 만든다 |
| `~/.config/ccrc/anthropic-api-key` | `brokerSessions: "apiKey"` 에 쓰는 API 키(0600) |
| `~/.config/systemd/user/ccrc.service` | 서비스 |
| `~/.local/state/ccrc/audit.jsonl` | 감사 로그 |
| `~/.local/state/ccrc/backup/` | 백업: 설정 migrate, 업데이트, 되돌리기, VS Code 설정, 서비스 유닛, 고쳐 쓴 대화 기록. 업데이트와 되돌리기 백업은 설정 폴더를 통째로 복사하므로 API 키, 비밀번호 해시, Web Push 키가 들어 있다. 가장 새 백업 셋과 마지막 업데이트 세 번의 백업만 남긴다 |
| `~/.local/state/ccrc/update-check.json` | 마지막 새 릴리스 확인 |
| `~/.local/state/ccrc/install.log`, `wrapper.log` | `install.sh` 와 래퍼의 로그(대화 내용은 없다) |
| `~/.local/state/ccrc/uploads/` | 휴대폰 첨부. 24시간 둔다 |
| `~/.local/state/ccrc/*.json`, `turns/`, `cli/`, `doctor/` | 작업 상태: 보관한 세션과 읽지 않은 세션, VS Code 보관에서 꺼낸 세션, 최근 원격 활동, 시작 설정, 모델과 context window 목록, 마지막 호환성 점검, 끊긴 턴 |
| `$XDG_RUNTIME_DIR/ccrc/link.sock` | 래퍼와 브로커의 소켓 |

설정 폴더와 상태 폴더(`~/.config/ccrc`, `~/.local/state/ccrc`)는 나만 열 수 있고(0700) 그 안의 파일은 0600 이다. 설치 폴더(`~/.local/share/ccrc`)에는 코드와 Node.js 가 있고 권한은 여느 폴더와 같다. API 키를 바꾸거나 폐기했다면, 옛 키가 아직 든 업데이트·되돌리기 백업(`~/.local/state/ccrc/backup/update-*`, `rollback-*`)도 지운다. 휴대폰에서 Claude Code 설정을 고치면 바꿀 때마다 바로 저장하고, 고치는 10분마다 한 번 파일 옆에 `settings.json.ccrc-<time>.bak` 으로 백업한다. ccrc 가 처음 파일을 바꾸기 전의 사본과 마지막 10개가 남는다. ccrc 파일 뷰어는 이 백업을 원본 파일처럼 비밀 파일로 다룬다.

## 보안 모델

- **tailnet 안에서만.** 브로커는 `127.0.0.1` 에서 듣는다. 휴대폰은 `tailscale serve` 를 거쳐 들어오고, `tailscale serve` 는 내 tailnet 안에서만 HTTPS 로 연다(Tailscale Funnel 이 아니다). 인터넷에는 아무것도 열지 않는다.
- **기기 허용 목록.** `tailscale serve` 로 들어온 요청은 그 tailnet 주소가 내 tailnet 의 기기이고 그 기기의 MagicDNS 이름이 `allowedDevices` 에 있을 때만 받는다(`tailscale status` 로 찾는다. 다른 tailnet 에서 공유받은 기기는 맞지 않는다). `ccrc setup` 은 이 컴퓨터가 속한 Tailscale 사용자의 휴대폰만 후보로 보여 주고, `--yes` 는 그런 휴대폰이 정확히 하나일 때만 추가한다. 이 컴퓨터 자신의 요청은 `allowLocal` 이 있어야 받는다. 이 컴퓨터의 프로그램은 자기 요청을 `tailscale serve` 를 거친 것처럼 꾸밀 수 있다. 그래서 `allowLocal: false` 로는 이 컴퓨터의 다른 사용자를 막지 못하고, 로그인이 막는다.
- **로그인.** ID 와 비밀번호로 로그인하고, 비밀번호는 Argon2id 해시로 저장한다. 로그인을 다섯 번 실패하면 5분 동안 잠그고, 잠금 시간은 두 배씩 늘어 한 시간까지 간다. 브로커를 다시 시작해도 잠금은 이어진다. 세션 쿠키는 HttpOnly, Secure, SameSite=Strict 다. POST 요청과 WebSocket 은 Origin 을 확인하고, 페이지에는 Content Security Policy 를 붙인다.
- **원격 로그인은 한 번에 하나.** 다른 기기나 창에서 로그인하면 먼저 묻고, 다른 로그인을 끝낸다. `leaseIdleMinutes` 동안 활동이 없으면 로그인이 끝난다.
- **패스키(선택).** 휴대폰은 ccrc 를 여는 호스트 이름에 패스키를 등록할 수 있다(WebAuthn. 사용자 확인이 필수라 Face ID 나 휴대폰 암호를 쓴다). 등록하거나 지울 때는 비밀번호를 다시 묻는다. 하나라도 등록되면 모든 원격 로그인을 시작할 때와 `passkeyHours` 가 지날 때마다 패스키로 확인한다. 확인 전까지 브로커는 확인과 로그아웃에만 답한다(HTTP 401 `passkey_required`. 열린 WebSocket 은 코드 4003 으로 닫는다). Claude 의 신뢰 기기처럼 기기마다 한 번 등록한다. 자기 패스키가 없는 허용 기기는 비밀번호 다음에 확인 대신 패스키를 등록하고, 그 뒤로는 그것으로 확인한다. 등록하기 전까지 그런 기기는 비밀번호로만 막힌다. 그러니 `allowedDevices` 에는 실제로 쓰는 기기만 적는다. 이 컴퓨터에서 하는 로그인은 묻지 않는다. 브로커는 답을 Node 의 crypto 로 직접 확인한다. 그 로그인에서 5분 동안 한 번만 쓰는 챌린지, 페이지의 origin 과 호스트 이름, 사용자 존재와 사용자 확인, 서명(ES256, EdDSA, RS256), 그리고 인증기가 카운터를 둘 때 올라가는 서명 카운터를 본다. attestation 은 요구하지 않는다. 잃어버린 패스키는 컴퓨터에서 `ccrc passkey reset` 으로 지운다.
- **원격 우회 없음.** 휴대폰은 어떤 세션도 `bypassPermissions` 로 바꿀 수 없다. 브로커가 거부하고, 래퍼도 그렇게 바꾸는 요청이나 답을 거부한다. 래퍼는 브로커가 보내는 제어 요청 중 허용 목록에 있는 것만 받는다.
- **파일.** 파일 뷰어는 세션의 폴더 안만 읽고, 그 밖은 있든 없든 "denied" 로 답한다. 비밀 파일(`.env*`, 키 파일, `.ssh`, `.gnupg`, 클라우드와 패키지 관리자 자격 증명, Claude Code 설정과 자격 증명, ccrc 자신의 폴더, `/proc`)은 모든 세션에서 막는다. Claude 가 휴대폰으로 보내는 파일, `@` 제안, 변경 사항 시트의 "git 전체" 줄에서도 막는다. "git 전체"도 세션 폴더 안 파일의 줄만 보여 준다.
- **다른 곳에서 연 세션.** 휴대폰의 글은 그 세션 자신의 수신 소켓으로만 다른 프로그램의 세션에 닿는다. 그 소켓은 내 것이어야 하고, 나만 열 수 있는 폴더에 있어야 하며, 메시지마다 보내기 전에 확인한다. 글은 Claude Code 가 자기 세션들에 알리는 peer 토큰과 함께 다른 세션의 메시지로 간다. 그래서 그런 메시지에 대한 Claude Code 의 규칙이 적용된다. 아무것도 승인하지 않고, 명령을 실행하지 않고, 설정을 바꾸지 않는다. 권한 요청을 건너뛰는 세션은 그 메시지를 보류한다.
- **감사 로그.** 로그인, 실패한 로그인, 거부된 기기, 보낸 메시지, 답, 모드와 모델 변경, 파일 읽기, 읽은 git 변경, 곁질문, 대화 내보내기, 새 세션, 갈래, 휴대폰에서 바꾼 `vscodeArchive`, MCP 로그인(서버 이름만. 마지막에 돌아오는 주소는 남기지 않는다), 패스키 등록·확인·거부·삭제를 `audit.jsonl` 에 남긴다. 메시지 내용은 남기지 않는다.
- **로컬 소켓.** 래퍼 소켓은 내 소유의 0700 폴더 안에 있고 0600 이다. 양쪽 모두 이를 확인하고, `/tmp` 같은 공용 폴더로 물러서지 않는다.
- **비밀.** API 키는 브로커 세션의 Claude Code 에 `ANTHROPIC_API_KEY` 로만 넘긴다. 로그, 감사 로그, 화면, API 답에는 쓰지 않는다. 알림에는 세션 제목과 요청 종류, 그리고 앱 아이콘이 세는 세션의 id 만 담는다. 그 기기에서 "도구 이름 표시"를 켜면 도구나 파일 이름, Claude 가 보낸 알림의 글도 담는다.
- **휴대폰의 사본.** 컴퓨터가 꺼져 있거나 닿지 않을 때도 최근 대화를 읽을 수 있게, 휴대폰은 마지막으로 보여 준 대화 다섯 개의 끝부분을 브라우저 저장소(IndexedDB, 하나에 최대 160KB)에 두고, 앱 자체는 서비스 워커 캐시에 둔다. 사본에는 오간 말과 도구 호출의 이름·요약이 들어간다. 도구 입력과 출력, diff, 명령 출력, thinking, 사진은 넣지 않는다. 사본은 읽기 전용으로만 보이고, 휴대폰의 로그인이 활동 없이 이어질 동안만 보인다(브로커가 받은 휴대폰의 마지막 요청이나 메시지부터 `leaseIdleMinutes` 에서 1분을 뺀 시간). 패스키를 쓰면 다음 확인 때보다 오래 보이지 않는다. 컴퓨터에서 이 시간들이 바뀌면(`leaseIdleMinutes`, `passkeyHours`, `ccrc passkey` 로 마지막 패스키를 지움) 연결된 휴대폰은 바로 안다.
  사본을 지우는 때: 로그아웃할 때, 그 시간이 다 됐을 때(사본을 보고 있는 화면에서도), 패스키로 로그인을 확인해야 할 때, 비밀번호가 바뀌었을 때 곧바로(휴대폰에서 바꾸거나, 휴대폰이 연결된 동안 `ccrc passwd` 로 바꿨을 때). 그 밖에는 휴대폰이 다음에 컴퓨터에 닿아 로그인이 끝났거나(`ccrc logout`, 다른 곳의 로그인) 비밀번호가 바뀌었거나 기기가 더는 허용되지 않음을 알게 될 때 지운다. 휴대폰 설정(계정과 보안 > "최근 대화를 휴대폰에 저장", 기본 켬)에서 끄면 사본도 지운다. 컴퓨터에 닿지 못하는 잃어버린 휴대폰은 그 시간이 다 될 때까지 잠금을 푼 사람에게 사본을 보여 준다. 컴퓨터에서 `ccrc logout` 을 실행하고, 휴대폰 잠금에 기댄다.

### 컴퓨터 밖으로 나가는 것

- **Claude Code** 는 늘 하던 대로 Anthropic API 와 통신한다. ccrc 는 여기에 아무것도 더하지 않는다.
- **새 릴리스 확인:** 브로커가 시작하고 1분 뒤, 그 뒤로 하루 한 번, 업데이트를 받는 저장소(기본은 GitHub)에 `git ls-remote` 를 한다. GitHub 는 컴퓨터의 주소와 시각을 본다. ccrc 는 버전이나 식별자를 보내지 않는다. `updateCheck: false` 로 끄고, `updateNotify: false` 는 알림만 끈다.
- **알림**은 휴대폰의 푸시 서비스(Apple 또는 Google)를 거치며 종단 간 암호화된다. 세션 제목과 요청 종류("도구 이름 표시"를 켜면 위에서 말한 이름과 Claude 의 글도), 그리고 읽지 않았거나 답을 기다리는 세션의 id 를 담는다. 휴대폰은 이 id 로 더는 필요 없는 알림을 닫는다.
- **Tailscale** 은 자기 조정 서버와 따로 연결을 유지한다. 휴대폰과 브로커 사이의 통신은 tailnet 안에 머문다.
- **휴대폰**은 마지막으로 보여 준 대화들의 끝부분 사본을 둔다(위의 "휴대폰의 사본" 참고).
- **설치와 업데이트**는 GitHub, nodejs.org, npm 레지스트리에서 받는다.

취약점은 [SECURITY.ko.md](SECURITY.ko.md) 에 적힌 대로 알린다.

## VS Code 래퍼의 알려진 빈틈

- 래퍼가 설정되면 확장은 "다른 곳에서 아직 열려 있음" 확인을 건너뛴다. ccrc 는 위에서 말한 대로 이를 메운다. 쉬고 있는 탭의 세션은 옮겨 오고, 아니면 이름 붙은 복사본으로 열리며 이를 알리는 줄이 뜬다. ccrc 는 먼저 물을 수 없으므로 확장의 "Open here anyway" 는 나오지 않는다. 세션이 떠난 탭은 다시 열 때까지 대화를 그때 모습 그대로 보여 준다.
- Plan 모드로 끝난 대화를 다시 열면 Plan 모드가 돌아오지 않는다.
- `claudeCode.useTerminal` 을 켜면 VS Code 는 래퍼를 쓰지 않는다. 그런 세션은 휴대폰의 글을 다른 세션의 메시지로만 받는다([다른 곳에서 연 세션](#다른-곳에서-연-세션) 참고).
- 휴대폰에서 바꾼 모델은 다음 답부터 VS Code 의 모델 선택에 보인다. 휴대폰에서 대기열에 넣은 메시지는 Claude Code 가 받아들인 뒤에 VS Code 에 보인다.
- Claude Code 의 대화상자는 휴대폰에도 보인다. 거절 대화상자(대체 모델로 계속하거나 메시지를 고친다)와 Auto 모드의 과금 안내는 ccrc 0.8 이상의 래퍼를 거쳐 휴대폰에서 답한다. 사용 크레딧 동의는 과금에 관한 선택이라 VS Code 에서만 답한다. VS Code 는 자체 실험 기능이 켜져 있지 않으면 거절 대화상자를 스스로 닫고, 그러면 휴대폰의 카드도 사라진다.
- 휴대폰에서 MCP 서버에 로그인하면 로그인 페이지가 휴대폰에서 열린다. 마지막 페이지는 Claude Code 가 컴퓨터의 `localhost` 로 보내는 리디렉트인데, 휴대폰은 이를 열 수 없다. 그래서 그 주소를 MCP 시트에 다시 붙여 넣는다.
- 다음은 ccrc 0.8 이상의 래퍼가 있어야 한다: 휴대폰에서 하는 곁질문, 카드와 에이전트 지도의 "백그라운드로", Claude Code 가 보는 그대로의 변경 사항 시트 "git 전체", 세션 자신의 Claude Code 가 주는 사용량 원인, 다시 연결한 브로커가 받는 최신 "/" 목록, 휴대폰에서 하는 MCP 로그인, 쉬는 탭에서 세션 옮겨 오기, PushNotification 이 휴대폰에 닿았다고 Claude 에게 알리기. 업데이트 전에 연 탭은 다시 열 때까지 옛 래퍼를 쓴다. 휴대폰에서 한 곁질문은 VS Code 의 곁질문 패널에 보이지 않는다.
- ccrc 를 손으로 지울 때는 파일보다 VS Code 설정을 먼저 지운다(`ccrc uninstall` 은 그렇게 한다).

## 한계

- 휴대폰 앱의 영어는 아직 모든 화면을 덮지 못한다. 덮지 못한 곳은 한국어로 보인다.
- systemd 가 있는 리눅스만 된다. macOS, WSL, VS Code Remote-SSH 는 안 된다. VS Code 설정은 `~/.config/Code` 에서, 확장은 `~/.vscode/extensions` 에서 찾는다. Microsoft 빌드가 두는 곳이다. Insiders, VSCodium, Code - OSS(Arch 의 `code` 패키지. Arch 에서는 `visual-studio-code-bin` 을 쓴다)는 안 된다. 다른 빌드면 setup 이 `vscode` 단계를 건너뛴다.
- 컴퓨터 하나에 사용자 한 명, 원격 로그인은 한 번에 하나.
- 세션은 컴퓨터에서 돌기 때문에 컴퓨터가 켜져 있고 온라인이어야 한다. 그렇지 않을 때 휴대폰은 마지막으로 보여 준 대화의 읽기 전용 사본만 보여 준다. 터미널이나 다른 프로그램에서 연 세션은 휴대폰의 글을 다른 세션의 메시지로만 받는다. 그 세션의 요청, 모델, 모드, 턴은 그쪽에 남는다.
- `apiKey` 모드에서 Claude 가 브로커 세션에서 실행하는 명령(예: Bash 도구)은 Claude Code 의 환경을 물려받으므로 키를 읽을 수 있다.
- 설치 프로그램은 새것이다. ccrc 는 Ubuntu 24.04 에서 매일 써 왔다. 2026-10-18 에 GitHub 의 `install.sh` 로 Ubuntu 24.04 의 기존 0.6 위에 v0.7.0 을 설치했다. setup 은 설정, 휴대폰 알림, `tailscale serve` 를 그대로 두고 서비스와 VS Code 래퍼만 설치본으로 옮겼다. 다른 배포판(Debian, Fedora, Arch, openSUSE)과 새 컴퓨터에는 아직 설치해 보지 않았다.

## 개발

```bash
git clone https://github.com/rjs0429/ccrc.git && cd ccrc
npm ci
npm run build        # 웹 앱(브로커가 제공)과 VS Code 래퍼의 중계기
npm run typecheck
npm test             # 브로커 단위 시험
npm run dev -w web   # Vite 개발 서버, :8737 의 브로커로 프록시
bin/ccrc serve
```

`bin/ccrc` 와 `bin/ccrc-wrapper` 는 Node.js 22.18 이상을 `CCRC_NODE`, `<dataDir>/node/bin/node`, 설치본이 기록한 Node, `PATH` 순서로 찾는다. 없으면 `ccrc` 는 오류로 멈추고, 래퍼는 Claude Code 를 바로 돌리며 `wrapper.log` 에 남긴다. 데스크톱에서 띄운 VS Code 와 서비스는 `PATH` 에 Node.js 가 없을 때가 많다. 그러니 체크아웃에서는 링크를 만든다: `mkdir -p ~/.local/share/ccrc && ln -s /path/to/node-v22 ~/.local/share/ccrc/node`. 브로커는 TypeScript 소스에서 바로 돈다(Node 의 type stripping). 래퍼는 빌드한 중계기가 소스보다 새것인 동안 그것을 쓴다.

체크아웃에서 `bin/ccrc setup` 을 돌리면 서비스와 VS Code 가 그 체크아웃을 가리킨다. `deploy/install-service.sh` 는 서비스 단계만 돌리므로 서비스만 바꾸고 VS Code 는 바꾸지 않는다. 설치본에서 커밋을 시험하려면 `ccrc update --from <repo>[@<ref>]` 를 쓴다.

GitHub Actions 는 `main` 과 `dev` 로 push 할 때와 pull request 에서 Node.js 22 로 같은 `npm ci`, 타입 검사, 시험, 빌드를 돌린다(`.github/workflows/ci.yml`).

설정 키, 상태 파일, 외부 도구, 경로를 더하는 변경은 `ccrc setup`, `broker/src/config.ts` 의 migrate, 이 README, CHANGELOG 의 Unreleased 절을 함께 고친다. 시험 자료에는 예시 값(`100.64.0.x`, `*.example.ts.net`, `/home/user`)만 쓴다.

`README.md`, `CHANGELOG.md`, `SECURITY.md` 를 고치면 같은 커밋에서 한국어판(`README.ko.md`, `CHANGELOG.ko.md`, `SECURITY.ko.md`)도 고친다.

## 버전

ccrc 는 [Semantic Versioning](https://semver.org) 을 따른다. 1.0 전에는 새 기능 단계나 호환되지 않는 변경이 MINOR 를, 고침이 PATCH 를 올린다. 릴리스는 `main` 의 annotated 태그이고, 태그는 절대 옮기지 않는다. 호환 약속은 명령, 포트, 최소 Node.js, VS Code 설정 한 줄, 래퍼 프로토콜(`LINK_VERSION`), 설정·상태 형식을 덮는다. 이 약속을 깨는 변경은 [CHANGELOG.ko.md](CHANGELOG.ko.md) 의 "호환성 깨짐"(영어판은 "Breaking")에 할 일과 함께 적고, `ccrc update` 는 묻기 전에 영어판의 그 줄을 보여 준다.

## 릴리스

릴리스 태그마다 [Releases 페이지](https://github.com/rjs0429/ccrc/releases)에 GitHub Release 가 있다. 거기에는 그 버전의 CHANGELOG 절(영어), 그 버전으로 설치하거나 업데이트하는 명령, 바로 앞 릴리스부터 바뀐 것으로 가는 링크가 있다. Release 는 자동으로 만든다. 태그를 push 하면 `.github/workflows/release.yml` 이 `scripts/sync-releases.sh` 를 돌린다(본문은 `scripts/release-notes.sh` 가 만든다). `-` 가 든 태그(`v0.8.0-rc.1`)는 pre-release 가 되고, 나머지 중 가장 높은 태그에 latest 표시가 붙는다. `main` 으로 push 하거나 워크플로를 손으로 돌리면, 실패한 실행이 빠뜨린 Release 를 채운다. 이미 있는 Release 는 건드리지 않는다. Release 에는 GitHub 의 소스 압축 말고는 파일이 없다. `install.sh` 와 `ccrc update` 는 태그에서 ccrc 를 내 컴퓨터에 빌드한다.

0.7.2 부터 릴리스 태그는 저장소 루트의 `.ccrc-allowed-signers` 에 적힌 SSH 키로 서명한다. 워크플로는 태그 서명이 그 파일과 맞을 때만 Release 를 만든다.

### 릴리스 확인하기

clone 한 저장소에서, OpenSSH 의 `ssh-keygen` 이 설치돼 있으면 이렇게 확인한다.

```bash
git fetch --tags
git -c gpg.ssh.allowedSignersFile=.ccrc-allowed-signers verify-tag v0.7.2
```

`Good "git" signature for 79899760+rjs0429@users.noreply.github.com with ED25519 key SHA256:7tvRIQuI7tARS7iihd3ezgTJycbqrIN8E9TPofkuAAw` 를 출력하고 0 으로 끝나야 한다. 서명이 없거나 파일에 없는 키로 서명한 태그는 실패한다. 이 줄이 나오는지 꼭 본다. OpenPGP 서명이면 git 은 파일이 아니라 내 GnuPG 키링으로 확인하기 때문이다(`ccrc update` 와 릴리스 워크플로는 SSH 서명만 받는다). 파일은 clone 에 딸려 오므로, 그 키를 작성자 GitHub 계정의 서명 키(<https://api.github.com/users/rjs0429/ssh_signing_keys>)와 비교한다. GitHub 도 태그에 Verified 를 표시한다. git 설정의 `gpg.ssh.program` 이 서명만 하는 프로그램이면 명령에 `-c gpg.ssh.program=ssh-keygen` 을 더한다.

`ccrc update` 는 0.7.2 부터 이 확인을 스스로 한다. 0.7.2 이상의 설치본에는 `.ccrc-allowed-signers` 가 있고, `ccrc update` 는 받은 태그를 빌드하기 전에 설치본 자신의 파일 사본으로 확인하며, 통과하지 못하면 멈춘다. 서명이 맞아야 하고, 태그는 받아 온 그 이름으로 서명돼 있어야 하며(서명된 옛 릴리스를 새 이름으로 내밀면 통과하지 못한다), 사본은 태그가 가리키는 커밋이어야 한다. 그 버전의 사본이 이미 `versions/` 에 있으면 쓰기 전에 같은 확인을 하고, 통과하지 못하면 태그를 다시 받는다. git 은 git 설정의 `gpg.ssh.program` 이나 `gpg.minTrustLevel` 과 상관없이 `PATH` 의 `ssh-keygen` 과 그 파일만으로 확인한다. 0.7.1 이하에서 0.7.2 로 가는 업데이트는 확인하지 않는다. 그 버전들에는 그 파일이 없기 때문이다. 원하면 위처럼 `v0.7.2` 를 손으로 확인한다. `ssh-keygen` 이 없으면 0.7.2 이상의 `ccrc update` 는 확인하지 못해 멈추고, 설치하는 명령을 알려 준다. `install.sh` 는 다른 기본 도구와 함께 `ssh-keygen` 을 설치하고(끝내 없으면 경고하고 계속한다), `ccrc setup` 은 없으면 경고한다. OpenSSH 8.2 보다 오래된 `ssh-keygen` 도 SSH 서명을 확인하지 못한다. 이때 `ccrc update` 는 그렇다고 알리고 멈추며, `ccrc setup` 은 미리 경고한다.

## 라이선스와 Anthropic 약관

ccrc 는 [MIT 라이선스](LICENSE)를 따른다.

ccrc 는 Claude Code 나 Claude Agent SDK 를 포함하지 않는다. Claude Code 는 오픈 소스가 아닌 Anthropic 의 소프트웨어이고, ccrc 는 사용자가 설치한 확장과 CLI 를 고치지 않고 돌린다. `npm ci` 는 Anthropic 의 약관에 따라 npm 에서 `@anthropic-ai/claude-agent-sdk` 를 받는다. ccrc 를 거쳐 Claude Code, Agent SDK, Claude 를 쓰는 일은 사용자와 Anthropic 사이의 계약(Consumer Terms 또는 Commercial Terms)과 [Usage Policy](https://www.anthropic.com/legal/aup)를 따른다. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 참고. Claude 와 Claude Code 는 Anthropic 의 상표이며, 여기서는 ccrc 가 무엇과 함께 동작하는지 말하려고만 쓴다.
