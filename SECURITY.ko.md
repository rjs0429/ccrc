# 보안 정책

[English](SECURITY.md) | 한국어

## 지원하는 버전

보안 고침은 가장 새 릴리스에 들어간다. 1.0 전에는 가장 최근 minor 버전만 지원한다. `ccrc update` 로 업데이트한다.

| 버전 | 지원 |
|---|---|
| 0.7.x | 예 |
| 0.6 이하 | 아니요 |

## 취약점 알리기

취약점은 GitHub 의 비공개 취약점 신고(private vulnerability reporting)로 알린다. 저장소의 **Security** 탭을 열고 **Report a vulnerability** 를 고른다(<https://github.com/rjs0429/ccrc/security/advisories/new>). 공개 이슈로 올리지 않는다.

찾은 것, ccrc 버전(`ccrc version`), 재현 단계를 적는다. 실제 tailnet 이름, 주소, 비밀번호, API 키는 빼고 적는다. ccrc 는 한 사람이 만드는 프로젝트라 답이 늦을 수 있다. 고침은 GitHub 보안 권고(security advisory)와 함께 patch 버전으로 낸다.

## 범위

대상: 브로커, 휴대폰 웹 앱, VS Code 래퍼, `install.sh`, `ccrc setup`, `ccrc update`, `ccrc uninstall`. 예를 들면 기기 허용 목록·로그인·패스키 확인을 통과하는 것, 세션 폴더 밖의 파일이나 비밀 파일을 읽는 것, 원격으로 세션을 `bypassPermissions` 로 바꾸는 것, 이 컴퓨터의 다른 사용자가 래퍼 소켓에 닿는 것이다.

대상이 아닌 것: Claude Code, Claude Agent SDK, VS Code 확장(Anthropic 에 알린다. <https://code.claude.com/docs/en/legal-and-compliance> 참고), Tailscale, 그리고 이미 내 컴퓨터에 나로 로그인한 사람이 있어야 하는 공격.
