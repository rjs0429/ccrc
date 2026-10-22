# Changelog

All notable changes to ccrc are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and ccrc uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). `ccrc update` shows the sections between
your version and the new one, and the lines under "Breaking" separately.

## [Unreleased]

### Added

- The phone app in English. It shows Korean when the phone's first preferred language is Korean and English otherwise
  (자동, the default), or the language chosen under Settings > Language (언어 / Language). The choice is kept on the
  phone, so the login screen follows it as well. Notifications are written in each phone's language: the app tells the
  broker when it subscribes and whenever its language changes, which the broker keeps as `lang` in that device's
  notification settings in `~/.config/ccrc/push.json`. A conversation exported from the phone gets the broker's
  headings and lines in the same language. English covers the settings home, the login screen, the account and input
  settings, the language setting, error messages, notes and the list's times so far; the rest still shows in Korean.
- `ccrc setup`'s `ssh-keygen` step also checks that it is from OpenSSH 8.2 or newer, which `ccrc update` needs to
  check release signatures: it asks ssh-keygen what git asks it, and one without `-Y find-principals` gets a warning
  that updates will stop at that check, with how to fix it. Setup goes on either way. `ccrc update`, when it stops
  for that reason, now says how to fix it as well.
- Notifications Claude decides to send: when Claude calls its PushNotification tool (after "tell me when the tests
  finish", say) and Claude Code runs the call, ccrc sends it to the phone at once, unless the phone is showing that
  session, and leaves out that turn's "작업을 마쳤습니다". A call Claude Code refuses or that fails sends nothing. The
  device setting "Claude가 보내는 알림" (on by default) turns them off; with "도구 이름 표시" on, the notification
  carries Claude's text. Claude Code's own call pushes nothing without Remote Control; a PostToolUse hook then makes it
  read "Mobile push requested." when ccrc sent it, Claude Code's "Not sent — this terminal is active" when the phone
  was showing the session, and leaves Claude Code's own answer otherwise. Broker sessions register the hook through the
  Agent SDK. In VS Code sessions a wrapper from this version adds it to the extension's `initialize` and answers it
  itself from what the broker last said (`claude_push` in the hello's `caps`); tabs opened with an older wrapper still
  get the notification, but Claude reads Claude Code's "not sent".
- Unread sessions. A session is unread when a turn ended while the phone was not showing it (any turn of a broker
  session; a VS Code session's turn when the phone sent to, started or answered in it after VS Code's last message,
  within two hours before the turn started) or when a notification about it went out, until the phone opens it or
  VS Code writes to it. The list shows a dot and has a "읽지 않음" filter; the session's ⋯ menu (under 더 보기) and a
  long press in the list offer "읽지 않음으로 표시" (and "읽음으로 표시"). Kept in `~/.local/state/ccrc/unread.json` (0600; session ids
  and times, for a month and 500 sessions at most), so it outlasts a broker restart; `ccrc uninstall --purge` removes
  it.
- Agent map: a subagent's transcript open on the phone now updates as Claude Code writes it. While it is open the
  broker watches the file (the kernel's file watch, or a look at its size twice a second where no watch is left, as an
  editor watching a large tree can use them all), reads only what was added, and sends the new items over the
  WebSocket; the phone reads it every 2 seconds again only when the broker cannot follow the file. A shell's output is
  read by the broker every second while it changes, every 2 seconds while it does not, and once more when the shell
  ends, and sent only when it changed.
- "백그라운드로" (move to background) on a Bash or Agent card the turn waits on, once Claude Code lists it as running in
  the foreground (a subagent after 2 seconds), and on the agent map's card of a subagent or shell running in the
  foreground: Claude Code moves it to the background, the card says it runs there, and the turn goes on. Broker
  sessions use the Agent SDK's `backgroundTasks`; VS Code sessions need this release's wrapper (reload the VS Code
  window), which says so in its hello and passes `background_tasks` on only for a call Claude Code runs in the
  foreground. With an older wrapper the card shows how to get it instead of the button.
- The changes sheet has two tabs. "이 세션" adds the files the session's subagents and workflow agents changed (Edit,
  Write, MultiEdit and NotebookEdit calls in their transcripts), marked as an agent's. "git 전체" shows the folder's git
  changes the way Claude Code's diff panel does: since the branch left its base branch when it is ahead of it
  (committed and uncommitted together), else since HEAD, with untracked files the session made. A running session
  asks its own Claude Code (`get_workspace_diff`, under its read rules); for a session without a process, or when
  Claude Code cannot answer, the broker works it out with read-only git commands. Either way the lines of key and
  token files and of files outside the session's folders stay hidden, and the same bounds apply (50 files, 1MB and
  400 lines a file, 2MB in all). Lines can be picked and commented into the composer as before.
- Side questions (`/btw` in the composer, or 곁질문 in the ⋯ menu) ask Claude Code beside the conversation, without
  interrupting a turn or adding to the conversation, and show its progress. The latest 20 questions and answers stay
  in the phone tab's sessionStorage and go with a follow-up as its thread, the latest first up to 256KB. A question is
  cancelled after five minutes or by the user. When the phone's connection drops while it waits, it waits again once
  it is back: the broker keeps how the question ended in memory for ten minutes. A question refused because an earlier
  one is still being answered elsewhere can give that one up and be asked again. A session without a process is
  started first, when the user asks.
- A fork can run in a worktree of its own: the fork sheet has the new-session screen's worktree switch and name, with
  the same checks. Claude Code makes a new worktree from the HEAD of the original session's folder, and the sheet says
  how many uncommitted files stay behind; a session already in a worktree forks into a new one beside it, from that
  worktree's HEAD. A worktree that is already there is not reused. The switch says why it is off outside git and for a
  session in a subfolder of its repository, whose fork would work at the worktree's top.
- A fork from a message, and a rewind to one, put the message's photos and documents back in the composer with its
  text, uploaded again from the transcript. The ones that cannot be (gone from the transcript, of a kind the phone does
  not attach, too large, past the composer's ten) are named.
- Claude's replies can be copied: a long press on a reply, or the ⋯ before its time, shows its Markdown as Claude wrote
  it, to copy whole or to select part of, and `/copy` copies the latest reply, as in VS Code.
- The conversation can be exported as a Markdown file, from the ⋯ menu (대화 내보내기 under 더 보기), `/export` or a
  reply's actions: a heading for each turn with its time in the phone's time zone, Claude's text as written and, unless turned
  off, a line for each tool call. The broker makes it from the transcript, so a stopped session exports too. It copies
  whole or downloads through a ticket that lasts a minute, as files do; each export is recorded in the audit log
  without its text.
- The usage sheet (`/usage`) shows, after the plan's limits, what the usage of the last day and week went to, as Claude
  Code reads it from this machine's transcripts for VS Code's Account & usage: the traits over a tenth of it with what to
  do about them (named in Korean where Claude Code 2.1.301 names them, by Claude Code's key otherwise), the subagent,
  skill, plugin and MCP server it came from most, and tables of each. The Context sheet has "사용량 원인 보기". The
  answer comes from the session's own Claude Code, another running one, or one started for the question, and is kept
  five minutes. A VS Code session answers it itself once its tab runs the wrapper of this version.
- Beside the Context ring, as in VS Code's prompt box, the minutes the prompt cache has left after the last reply, or
  that it ran out; the Context sheet says how long the session has been idle and how many tokens the next message
  caches again. It follows the time to live Claude Code asked for (`cache_creation`) from the request of the last
  response, and a stopped session's comes from its transcript.
- A plan's lines take comments: tap a line of the plan to write one, tap it again to change it. "계속 계획하기" sends
  them after the feedback as `줄 n "<the line>": <comment>`, a code block by its first line of code.
- Sessions open in a terminal, in the background, under `claude -p` or in a VS Code tab opened before the wrapper
  take text from the phone through Claude Code's inbox socket for messages from other sessions (Claude Code 2.1.224
  or later). Claude gets it as a message from another session, "ccrc 휴대폰", and the composer says so before
  sending: what Claude asks again where the session runs, that "/" commands are not run, and, from the transcript's
  last permission mode and the `crossSessionInbound` settings ccrc can read, when the message waits for approval in
  the terminal or in `claude agents` or is not delivered. The message waits under the conversation until its
  transcript shows it. Such sessions no longer read "보기만" in the list, and a background session reads as open in
  the background; a session of another inbox format stays view-only.
- On iOS, when the app comes to the front within two minutes of a notification about a request that still waits, it
  goes to that request's card, once per request: iOS can open the app from a notification without going where it
  points. A notification's tap that reaches the app decides instead, and the service worker marks the address it opens
  the app at (`?tap=1`). Other platforms, a new session's draft and answered requests are left alone. The broker says
  which request it was (`GET /api/push/recent`).
- The config key `vscodeArchive` (default `false`, also switched on the phone in 알림과 입력 > 세션 목록): sessions
  VS Code's Claude Code extension archived, by hand or after its days without use, count as archived in ccrc's list,
  marked "VS Code 보관". VS Code's state database is only read. Bringing such a session back on the phone, or sending
  it a message, keeps it in the list (`<stateDir>/vscode-unarchived.json`) and leaves it archived in VS Code; the mark
  goes once VS Code shows the session again.
- Claude Code's dialogs can be answered on the phone. When the model refuses a message and Claude Code asks what to do
  (with `switchModelsOnFlag` off), the card offers going on with the fallback model, editing the message (which comes
  back in the composer) or closing it; auto mode's notice that its classifier now runs billed requests offers going on
  or stopping the turn. The buttons take a tap only after the card has shown for half a second. Broker sessions declare
  the refusal dialog to Claude Code, so it asks instead of ending the turn; they leave auto mode's notice undeclared, so
  there Claude Code goes on in auto mode without asking, as before. A dialog nobody answers is closed by Claude Code
  after its `dialogExpiry` (5 minutes by default) with the dialog's default: the refusal stands and the turn ends, and
  auto mode's notice stops the turn. VS Code sessions need this version's wrapper (`user_dialogs` in the hello's
  `caps`), which passes on only an answer the dialog offers and tells VS Code to close its copy. Fable's usage credits
  consent stays with VS Code: the phone shows what it asks and the credits left, read only. The notification of a
  dialog names what it asks.
- Signing in to an MCP server from the phone: the MCP sheet offers 인증 for an HTTP or SSE server or a claude.ai
  connector that needs it. Claude Code starts the sign-in (`mcp_authenticate`) and the phone opens its page; its last
  page is Claude Code's redirect to the machine's `localhost`, which the phone cannot open, so its address is pasted
  back in the sheet and Claude Code finishes there (`mcp_oauth_callback_url`), then connects the server again. Only a
  redirect to `localhost` with a code goes to Claude Code, and the audit log names the server only. VS Code sessions
  need this version's wrapper (`mcp_auth` in `caps`), which passes on the server's name alone (Claude Code picks the
  redirect) and of its answer only the page and whether a redirect comes back.
- Passkeys (Face ID) confirm remote logins. In 계정과 보안 a phone registers one, after its password, for the host name
  it opens ccrc at. From then on every login from a device other than the machine itself is confirmed with a passkey
  when it starts and again after `passkeyHours` (new config key, 18 by default), as Claude's own Remote Control does
  for trusted devices; until then the phone shows only the passkey screen. Another allowed device, a second phone or a
  tablet, registers its own on that screen at its first login, after the password; a device that has registered one
  confirms with it. Removing one asks for the password too; `ccrc passkey [list | remove <id> | reset]` lists and
  removes them on the machine, for a lost phone. Kept in `~/.config/ccrc/passkeys.json` (0600; public keys and when
  each was used), which `ccrc uninstall --purge` removes. The broker checks registrations and confirmations itself
  with Node's crypto; there is no new dependency. `ccrc rollback` to 0.7.x turns the confirmation off: 0.7 does not
  read `passkeys.json`, so the password alone logs in. The passkeys stay, and updating again brings the confirmation
  back.
- Recent conversations to read while the machine is off. The phone keeps the end of the last five conversations it
  showed (80 items or 160KB each at most) in the browser's IndexedDB: what was said, tool calls by name and summary,
  file names. Tool input and output, diffs, command output, thinking and pictures stay on the machine. When the broker
  cannot be reached (the machine off or asleep, Tailscale down, the broker stopped or answering with an error), the
  app still opens and lists them; a conversation opens read only and says so, and the app goes back to the live ones
  once the broker answers. The copy belongs to the login: logging out, a new password (on the phone, or with
  `ccrc passwd`, which a connected phone hears of at once), a login ended at the machine (`ccrc logout`, idle time, a
  login on another device), the device leaving `allowedDevices`, `leaseIdleMinutes` passing without reaching the
  broker (also while the copy is on screen) and a passkey confirmation coming due all delete it. "최근 대화를 휴대폰에
  저장" under 계정과 보안 (on by default) turns it off and deletes it, and shows how much it holds. `/api/me` also gives
  a logged-in phone `leaseIdleMinutes`, when the password was set (`loginSetAt`) and, with passkeys, how long until the
  next confirmation (`passkeyLeftMs`); a connected phone asks again when one of them changes while the broker runs.

### Changed

- `install.sh` no longer stops when `ssh-keygen` is the only base tool missing. It still offers to install it, asking
  for sudo as before; when it stays missing (sudo not given, `--no-system`, no package manager, or its install
  failing), the install goes on with a warning that `ccrc update` will stop at the signature check until it is
  installed. Installing never used it: `install.sh` does not check tag signatures.
- The composer's agent chip stays for the whole conversation: dimmed until the conversation uses a subagent or
  workflow, and beside the notice that takes the composer's place in a session the phone can only view (open in VS
  Code or a terminal and taking no messages from here, its folder gone, remote sessions off). Tapping it opens the agent map, which says when no
  agent was used. Its running count has a place two digits wide, empty while no agent runs, so the chip keeps one
  width. The Context ring moved next to the paperclip: one line reads paperclip, Context, model, Effort, agents …
  permission mode, send; when that does not fit, line 1 holds the agent chip and the permission mode, line 2 the rest.
  The new-session screen has neither the ring nor the agent chip.
- Claude Code settings on the phone are saved as soon as they are changed: a switch or choice when it is picked, text
  on Enter or on leaving the field, a rule or folder when it is added or removed. A toast says what was saved and can
  undo it; the save bar, "변경 취소" and the confirmation sheet are gone. Saves go one at a time in the order made,
  each against the file the last one left, and a key changed again before its turn is saved once. When the file
  changed meanwhile, the change still goes through if its own key was left alone; otherwise the file's value is shown.
- Backups of Claude Code's settings (`settings.json.ccrc-<time>.bak`) are made once per ten minutes of editing instead
  of once per save, and the one from before ccrc first changed the file is kept besides the last ten.
- Effort in the Claude Code settings is set per model (`modelSettings.<model>.effortLevel`, where `/effort` saves it),
  for each model Claude Code offers with effort levels and each the file names. A top-level `effortLevel` (what the
  Effort row of 0.7 saved) still reaches the older models, such as Fable 5.1 and Opus 5, that have no effort of their
  own, but not the 5.5 ones: it is shown on those models' rows and on a row of its own, where it can only be removed.
- The app icon's badge counts the sessions waiting for an answer and the unread sessions, the same sessions the list
  marks. It no longer depends on which device was told, and a turn that starts by itself no longer clears it.
- Notifications that no longer count are closed: the end of a turn, Claude's notification and files sent once the
  session is read (opened on the phone or written to in VS Code), a request once it is answered, and any notification
  once a newer one of the same session and kind shows (iOS keeps both otherwise). The phone does this when the app
  comes to the front, opens a session or hears that the list changed, closing the notifications of the session it
  shows as well, and when the next notification arrives: every notification now carries when it was made and the ids
  of the sessions left unread or waiting for an answer, and the test notification and the update notice carry the
  badge too. A notification too long with those ids goes without them. While the app is closed nothing else reaches
  the phone, so a session read in VS Code keeps its notification, and the icon its number, until then. iOS 26.5 and
  later do not close a notification within 30 seconds of showing it; the app tries again once that has passed, while
  it stays in front. 알림 끄기 and logging out close the app's notifications.
- Long sessions open faster on the phone. A conversation opens with its latest 40 items or so, and earlier ones load as
  you scroll up, keeping your place; a search hit or a subagent far back opens with the part around it, and the part
  after it loads as it comes into view. The broker keeps a conversation it has built until its transcript changes, reads
  a compacted transcript from its last compaction only, and compresses what it sends over the WebSocket
  (permessage-deflate).
- The rewind list, the changes sheet, the to-do panel, the agent chip and the agent map cover the whole conversation,
  whatever part of it the phone has loaded.
- The VS Code wrapper also passes on `get_workspace_diff` (nothing else in the request) and `side_question` (the
  question and its thread, text only), the progress of the broker's side questions and their cancelling, and tells the
  broker so in its hello (`workspace_diff`, `side_question`). VS Code tabs opened before the update keep the older
  wrapper until they are opened again: side questions are off there, and git changes are read by the broker.
- A NotebookEdit call shows the cell's change when Claude Code reports the cell's source from before it.
- The session's ⋯ menu keeps its four tiles and the rows used most: 곁질문, 되돌리기, 변경 사항, Context와 사용량 and
  에이전트 지도. MCP 서버, 출력 스타일, 읽지 않음으로 표시, worktree 정리 and 원격 실행 끝내기 moved under its last row,
  더 보기, which shows them in the same sheet and leads back to the menu where it was; 대화 내보내기 is there too. The
  menu has the same rows in every session and, with 이번 턴 중지 on top while a turn runs, still fits a 390×844 screen.
- The "/" list follows the commands Claude Code announces during a session (when a command or skill file is written,
  or plugins or skills reload), in sessions the broker runs and in VS Code, and leaves out the commands Claude Code
  binds to its own terminal (such as `/color` and `/focus`). A broker session's list is known from its start instead
  of its first turn. The wrapper hands the latest list again to a broker that connects anew.
- Sessions run by `claude -p` show as open in "SDK" instead of "sdk-cli".
- `ccrc status` shows the passkeys, and `ccrc setup` tells about registering one on the phone.

### Fixed

- `ccrc update` checked release signatures with the `gpg.ssh.program` of your git config, if one was set, and under its
  `gpg.minTrustLevel`. A program that only signs, or the trust level `ultimate`, stopped the update at a good
  signature, reported as one that does not check out or as needing OpenSSH 8.2 while `ccrc setup` found `ssh-keygen`
  fine. It now always checks with the `ssh-keygen` on `PATH`, the one setup checks, against `.ccrc-allowed-signers`
  alone.
- The composer no longer moves while typing in a session whose agents start and end: the agent chip coming and going
  changed the number of chip lines, and its running count its width. The input also fits its text again when the
  window's size changes, so the first key after turning the phone no longer grows it by a few pixels.
- Sessions whose transcript starts with a long first message (one typed while Claude worked, with pasted text or
  images) were listed under a folder with no name and could not be opened: their working folder now comes from the
  transcript, or, when it names none, from the other sessions of the same project folder.
- Picking "Default (recommended)" in the phone's model sheet saved `"model": "default"`, which Claude Code takes for a
  model name, so the effort set for the default model did not apply. That entry is now the sheet's "기본값", which
  removes the key, and "default" is not saved as a model; one already in the file is shown as it is, with a hint.
- Turning notifications off and on again on a phone keeps the choices made before (VS Code delay, turn end, tool
  names) instead of going back to the defaults.
- The conversation no longer moves while subagents or background tasks report progress. It stays at the bottom only
  while you are at the bottom, keeps what you are reading in place otherwise (Safari has no scroll anchoring of its
  own), and marks new content only when a message, a request or a reply comes. A running subagent's card no longer
  shrinks and grows with each step, and a message that wraps as you type no longer pulls the conversation up.
- `ccrc update` said to reload VS Code windows only when the wrapper protocol changed. Claude tabs opened before an
  update need a reload to get the new wrapper's features too (the names in its hello's `caps`), so it now also says so
  when there are new ones, and names them. The version you update from gives this advice: updating from 0.7 still does
  not, see "Upgrading from 0.7".
- The ⋯ button in a conversation's header took taps on a 36px square; it now takes them on 44px, as the back button
  does.
- Opening the app while the broker could not be reached showed "Safari cannot open the page" or, from the browser's
  cache, a spinner that never ended. The service worker now keeps the app's page and its files (`/assets/`, the
  current and the previous version) and serves them when the network fails, answers with an error or takes more than
  3.5 seconds; it never handles `/api/`. The app then asks the broker again every few seconds and on "다시 연결".
- While the connection is down, requests that fail in the network no longer toast "Failed to fetch" every ten seconds
  on the session list, and the "연결이 끊겼습니다" banner stays up between reconnection attempts.

### Security

- The wrapper passed the broker's `get_usage` on to Claude Code with whatever else the request carried. It now takes
  only `skip_behaviors`, and passes back the causes of usage (traits, and the names and shares of subagents, skills,
  plugins and MCP servers) besides the limits and session totals, nothing else of the answer.
- `ccrc setup` offered every iOS and Android machine in the tailnet for `allowedDevices`, and `--yes` allowed all
  the online ones, phones of other people in a shared tailnet included. It now offers only the machines of the
  Tailscale user this machine belongs to, and `--yes` adds one only when there is exactly one; otherwise it adds none
  and says how to add yours (`ccrc setup` in a terminal, or `ccrc config set allowedDevices`). A tagged machine, or a
  Tailscale that does not report users, gets none offered. A list already in config.json is left as it is: to see
  whether an earlier `--yes` let in phones that are not yours, look at `devices` in `ccrc status`.
- `ccrc update` used a copy of the version it updates to that was already in `versions/` without checking its tag: one
  left by `install.sh`, which does not check signatures, or by an update checked against an older
  `.ccrc-allowed-signers`. It now checks such a copy as it checks a download, and fetches the tag again when the copy
  does not pass.
- `ccrc update` took a signed tag of an older release, offered under a newer release's name, for the newer release, as
  `git verify-tag` does not look at the name. It now checks that the tag was signed under the name it was fetched as,
  and that the copy is at the commit the tag names.

### Upgrading from 0.7

- A phone whose first preferred language is not Korean shows the app in English after the update. To keep Korean,
  choose 한국어 under Settings > Language.
- Phones that turned notifications on under 0.7 are written to in Korean until the app is opened once after the
  update, when it tells the broker its language.
- The next notification closes those that no longer count once the phone has the new service worker, which it fetches
  when the app is opened; iOS may keep the old one until the app is closed in the app switcher and opened again.
- After `ccrc update`, reload VS Code windows (Developer: Reload Window): updating from 0.7 does not say so, and a
  Claude tab opened before the update keeps the wrapper of 0.7 until it is opened again. Until then, in that tab's
  session, the side question sheet and the cards and agent map that would offer "백그라운드로" say to open Claude Code again
  instead, the changes sheet's git view is read by the broker, the usage sheet's causes come from another Claude Code,
  a "/" list Claude Code changed while the broker was away shows from its next change, Claude Code's dialogs are
  answered in VS Code only, the MCP sheet's 인증 says the wrapper does not know it yet, and Claude reads Claude Code's
  "not sent" after a PushNotification call that reached the phone.

## [0.7.3] - 2026-10-18

### Fixed

- A machine without OpenSSH's `ssh-keygen` installed ccrc but stopped at its first `ccrc update`, which checks release
  signatures with it. `install.sh` now counts `ssh-keygen` among the base tools and installs it with them
  (`openssh-client`, `openssh-clients` or `openssh`, asking for sudo as before); `ccrc setup` has an `ssh-keygen` step
  that says why it is needed and how to install it; and `ccrc update` says what to install, or that OpenSSH is older
  than 8.2, instead of reporting a signature that does not check out.

## [0.7.2] - 2026-10-18

### Added

- GitHub Releases: `.github/workflows/release.yml` runs `scripts/sync-releases.sh` when a tag is pushed, which makes a
  Release for each tag from v0.7.0 that has none, with its CHANGELOG section, install and update commands and a
  compare link (`scripts/release-notes.sh`). Tags with a `-` become pre-releases; pushes to `main` and a manual run
  fill in releases a failed run left out.
- CI: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on Node.js 22 for
  pushes to `main` and `dev` and for pull requests.

### Security

- Release tags are signed with SSH from 0.7.2, with the keys in `.ccrc-allowed-signers` at the repository root. An
  install of 0.7.2 or newer holds that file, so `ccrc update` checks each tag it updates to with `git verify-tag` and
  stops unless it carries an SSH signature from a key in that file; this needs OpenSSH's `ssh-keygen`. The release
  workflow makes no Release for such a tag either. The update from 0.7.1 or older to 0.7.2 is not checked; the README's
  "Verifying a release" shows how to check a tag by hand.

## [0.7.1] - 2026-10-18

### Changed

- Consent to sudo is no longer taken from `--yes`. In `install.sh` and `ccrc setup`, every use of sudo (base tools,
  Tailscale's installer, `tailscale up`, `tailscale set --operator`, and `sudo loginctl enable-linger` when linger
  needs it) says what it runs and why and asks at the terminal, `--yes` or not. Without a terminal it runs only with
  the new `--allow-sudo` option, which `install.sh` also passes on to setup; otherwise `install.sh` stops before
  installing base tools, and setup leaves the step as "sudo consent needed", goes on with the steps that do not need
  it, and says how to finish. `deploy/install-service.sh` still uses no sudo. When `install.sh` installs an earlier
  version, whose setup takes `--yes` as consent to sudo, it runs that setup without `--yes` (or, without a terminal,
  stops before it) unless `--allow-sudo` is given.

### Fixed

- When looking for a new version fails (the update check, and `ccrc update`), the message now names the line of
  git's output that says why ("Repository not found.", "Could not resolve host", a timeout) instead of git's closing
  advice ("and the repository exists."). A user name or token in the repository URL is still left out.

## [0.7.0] - 2026-10-18

The first public release: an installer, updates, and the changes needed to run on machines other than the author's.

### Breaking

- The VS Code wrapper now needs Node.js 22.18 or newer, as `ccrc` does (its built relay used to run on Node.js 20).
  Without one it runs Claude Code directly and notes it in `wrapper.log`, so VS Code keeps working but the phone cannot
  see or drive its sessions.
- `bin/ccrc` and `bin/ccrc-wrapper` no longer look in `~/.local/opt/node22`. They look in `CCRC_NODE`,
  `<dataDir>/node/bin/node`, the Node.js the install recorded, then `PATH`. A development checkout needs one of these
  before it is updated: see "Upgrading from 0.6".
- `allowedDevices` matches only the first label of a machine's MagicDNS name in your tailnet, no longer the host name
  the machine reports itself, and never machines shared in from another tailnet. An entry that named a host name
  different from the MagicDNS name no longer lets that machine in.

### Added

- `install.sh`: checks the platform, installs missing base tools (asks first, uses sudo), downloads Node.js 22 checked
  against `SHASUMS256.txt` when no Node.js 22.18+ is found, builds ccrc into `~/.local/share/ccrc/versions/<version>`,
  links `current` and `~/.local/bin/ccrc`, then runs `ccrc setup`. Options `--version`, `--ref`, `--from`,
  `--channel stable|rc`, `--yes`, `--dry-run`, `--no-system` and `--uninstall`; other options, and everything after
  `--`, go to `ccrc setup`. Environment `CCRC_REPO_URL`, `CCRC_DATA_DIR`, `CCRC_STATE_DIR`, `CCRC_NODE` and
  `CCRC_NODE_DIST`. It reuses the Node.js an existing install recorded, and logs to `<stateDir>/install.log`.
- `ccrc setup [--yes] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]`:
  checks each part (Claude Code, Tailscale install, login and operator, MagicDNS and HTTPS, the allowed phone, the ccrc
  login, settings, the service, `tailscale serve`, the VS Code wrapper setting, the phone, the compatibility check) and
  does only what is missing; running it again finishes or repairs. It asks how broker sessions sign in, and changes
  VS Code's `settings.json` in place, keeping comments and layout, after a backup. It keeps settings already in
  config.json (an empty `roots` list too), signs in to Tailscale with a bare `tailscale up` so the machine's other
  Tailscale settings stay, and asks before turning on linger. With `--yes`, steps that use sudo run without asking.
- `ccrc uninstall [--purge] [--yes] [--dry-run]`: removes VS Code's wrapper setting first, then the service,
  `tailscale serve` and the installed versions; `--purge` also removes settings and state, and keeps the copy of VS
  Code's settings next to `settings.json`. `<dataDir>/node` stays while a development checkout the service or VS Code
  runs still needs it.
- `ccrc update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repo>[@<ref>]]`: builds a release
  beside the running one, shows its changes, backs up and migrates config and state, switches the `current` link,
  restarts the service and checks `/api/ping`, going back on its own when the new version does not answer (exit code 3;
  4 when the old version cannot be confirmed either). A failed update puts config and state back exactly as they were.
  Ctrl-C is held until a switch is confirmed or undone.
- `ccrc rollback`: returns to the version before the last update and restores the config and state files that update's
  migration reported changing (`ccrc migrate --json`). Exits with code 4 when the service cannot be restarted.
- `ccrc update`, `ccrc rollback`, setup's service step and `ccrc uninstall` refuse to run inside `ccrc.service` (a
  session the broker started, such as one asked from the phone), whose restart would stop them halfway.
- Update and rollback keep their three newest backups and those of the last three history entries, and remove older
  ones.
- `<dataDir>/history.json`, a record of each update and rollback with its backup folder.
- Optional tag signature checks: when an install has `.ccrc-allowed-signers`, `ccrc update` requires
  `git verify-tag` (SSH signatures) to pass.
- A new-release check in the broker, a minute after start and then daily (`git ls-remote` with a time limit), stored in
  `<stateDir>/update-check.json`, with the config keys `updateCheck`, `updateChannel`, `updateRepo` and `updateNotify`.
  An install sends one push notification per new release to subscribed phones.
- The settings status page and `/api/health` show the ccrc version, whether it is an install or a development checkout,
  the newest release with a link to its changes, and when it was last checked.
- `brokerSessions` setting (`off`, `apiKey`, `subscription`) decides whether and how sessions ccrc starts itself through
  the Agent SDK sign in. New installs default to `off`.
- With `apiKey`, broker sessions get the key stored by `ccrc config set-api-key` (`<configDir>/anthropic-api-key`,
  0600), and nothing else sees it.
- When broker sessions are off or have no key, the phone greys the new-session button, shows the reason and how to turn
  them on, and hides the start and fork actions; the status page shows the mode read-only. Storing a key while the
  broker runs tells an open phone right away.
- `ccrc config path | get [key] | set <key> <value> | set-api-key` to read and change config.json from the terminal.
- `ccrc update --from` records where the install looked for releases before (`updateSource` in the install info), so
  trying local work does not move the new-release check off GitHub.
- `ccrc version` (and `--version`): the installed version, `git describe` for a development checkout, else
  package.json's.
- `GET /api/ping` answers `{ ok, version }` without a login, to this machine always and to allowed devices.
- config.json is checked on load: a key of the wrong type stops the broker with the key and what it takes, unknown keys
  are warned about, and broken JSON is reported with its line and column.
- A running broker takes in changes to `allowedDevices`, `allowLocal`, `roots`, `brokerSessions`, `leaseIdleMinutes`,
  `sessionIdleMinutes` and the update keys without a restart, and logs that `host`, `port` and `claudePath` need one.
- config.json has a `schemaVersion`. `ccrc serve` and `ccrc migrate` bring older files up to date after copying them to
  `<stateDir>/backup/`; a file from a newer ccrc is refused with a hint to update or roll back.
- `CCRC_VSCODE_EXTENSIONS_DIR` sets the VS Code extensions folder.
- README for public use, this changelog, a license (MIT) and a security policy.

### Changed

- `ccrc status` also shows the version, the newest release the broker has seen, and the `brokerSessions` mode.
- `deploy/install-service.sh` runs setup's service step: the unit runs `<dataDir>/current/bin/ccrc serve` for an
  install, records `CCRC_NODE`, and checks `/api/ping`; a replaced unit is copied to `<stateDir>/backup/`, and its
  `Environment` lines that setup does not write are carried over. Linger is optional and left as it is with `--yes`.
  It changes only the service, not VS Code's setting.
- package.json carries the version.
- New dependency: `jsonc-parser`.

### Fixed

- Claude Code's folder follows `CLAUDE_CONFIG_DIR` everywhere, not only for its settings file.
- The VS Code wrapper finds an installed Node.js when VS Code was started from a desktop whose `PATH` has none, instead
  of quietly running Claude Code without ccrc.

### Security

- `install.sh`, `ccrc setup` and `ccrc uninstall` refuse to run as root.
- `ccrc uninstall` never touches `/`, your home folder, `~/.config`, `~/.local`, `~/.local/share`, `~/.local/state`,
  `~/.cache` (or the `XDG_*` folders) or a folder holding one, and removes a folder whole only when it is named `ccrc`;
  elsewhere it removes only what ccrc makes.
- Copies of Claude Code's settings that the phone's settings editor keeps (`settings.json.ccrc-<time>.bak`) are secret
  files to the file viewer, attachments and `@` suggestions, as `settings.json` is.
- `install.sh` keeps its log private (state folder 0700, `install.log` 0600) and keeps Node.js downloads from an https
  source on https.
- The API key never reaches logs, the audit log, the screen or API answers; in `apiKey` mode an inherited
  `CLAUDE_CODE_OAUTH_TOKEN` is removed from broker sessions' environment.
- The new-release check runs git without password prompts or credential helpers, and masks a user name or token in a
  repository URL in errors shown on the status page.

### Upgrading from 0.6

- A development checkout must find Node.js 22.18+ **before you update it** (`git pull` or `git merge`), not only before
  restarting the service: VS Code runs the checkout's `bin/ccrc-wrapper` directly, so from the moment the new code is
  in place, new Claude tabs run without ccrc when it finds no Node.js, and the service fails to start at its next
  restart. VS Code started from a desktop and the service often have no Node.js on `PATH`. Make the link first, then
  update, then check that `ccrc` finds Node.js without `PATH`:

  ```bash
  mkdir -p ~/.local/share/ccrc && ln -s /path/to/node-v22 ~/.local/share/ccrc/node
  ~/.local/share/ccrc/node/bin/node --version      # v22.18 or newer
  git pull                                         # or git merge
  env -i HOME=$HOME PATH=/usr/bin:/bin bin/ccrc version
  ```

  The link serves both `ccrc` and the wrapper. `deploy/install-service.sh` (run from a shell that finds Node.js 22.18+)
  writes that Node into the service unit as `CCRC_NODE`, which only the service reads; without the link, the wrapper
  needs `CCRC_NODE` in `claudeCode.environmentVariables` instead.
- 0.6 has no `ccrc update`. Either update the checkout (`git pull`, `npm ci`, `npm run build`, then
  `systemctl --user restart ccrc.service`), or move to an install with `install.sh`, which keeps your settings, login
  and notification subscriptions and points the service and VS Code at the install.
- On its first start, 0.7 moves `config.json` to `schemaVersion: 1` and adds `"brokerSessions": "subscription"`, so
  broker sessions keep working as before. The earlier file is kept in `<stateDir>/backup/migrate-0-1-<time>/`. To turn
  broker sessions off or move them to an API key: `ccrc config set brokerSessions off` (or `apiKey`, after
  `ccrc config set-api-key`).
- Check that each name in `allowedDevices` is the first label of the device's MagicDNS name (`tailscale status`).
- Reload VS Code windows so open tabs use the new wrapper, and fully close and reopen the phone's home screen app.

### Tested with

- Claude Code VS Code extension and CLI 2.1.301, Claude Agent SDK 0.3.296
- Node.js 22.18 or newer; Ubuntu 24.04 with systemd 255; Tailscale 1.104.1
- iOS 16.4 or later (home screen app, for notifications)

## [0.6.0] - 2026-10-16

### Added

- Rename sessions (also seen by VS Code and `claude --resume`) and archive them within ccrc.
- Fork a session from the menu or from any message into a new broker session that can run in the background;
  `/fork` and `/branch` open the fork sheet.
- Rewind the conversation as Claude Code does: conversation and code, conversation only, or code only. Broker sessions
  rewind in place; VS Code sessions continue in a fork from that point.
- Start a new session in a new git worktree, and clean worktrees up from the session menu or when archiving.
- Fast mode and Thinking switches for the current session, with markers on the composer.
- Claude can send files to the phone (`SendUserFile`, Claude Code 2.1.300 or later), opened by reference, with secret
  files blocked and a 50 MB limit. `CCRC_SEND_FILES=0` turns it off.
- Agent map: read a subagent's transcript, and the output of shell and monitor tasks.
- Turn-done notifications in three choices (sessions driven from the phone, all sessions, off), an app icon badge, and
  separate wording and urgency for errors, usage limits and Claude Code exiting unexpectedly. Turn-done notifications
  also survive a broker restart.
- Prompts that only VS Code can answer are marked as such in notifications.

### Changed

- `claudePath` defaults to `"vscode"`: broker sessions use the CLI bundled in the newest VS Code extension.
- Composer chips fit on one line when they can, two otherwise; the session menu puts the four frequent actions first.
- Web Push reuses its VAPID signature for six hours and retries once with a new one on 401 or 403.

## [0.5.0] - 2026-10-15

### Added

- Session search by title and message text, jumping to the message found.
- Output style per session, from the session menu.
- MCP input requests (elicitation) answered on the phone, for broker sessions and for VS Code sessions while the
  phone is reachable.
- Model, effort, ultracode and permission mode can be chosen for an inactive session, and applied when ccrc starts it;
  a "start now" button starts it without a message.
- A context ring next to the model chip, opening Context, plan usage and Compact.
- Dedicated views for AskUserQuestion, plan approval and 19 other tools; a raw view for the rest.
- Queued messages show at the bottom until Claude Code takes them, can be taken back, and stay in step with VS Code.
- Photo thumbnails with a full-screen viewer, a jump-to-bottom button, and timestamps under Claude's replies with date
  separators.
- A new-session screen with the full composer (`@`, `/`, attachments, chips).
- Agent map: subagents, workflows and background tasks of a session.
- Agent reports and messages from other sessions as collapsed cards; `!` commands as shell cards.
- Landscape layout, with notch and home indicator areas kept clear.

### Changed

- Commands that open a window in Claude Code (`/context`, `/usage`, `/mcp`, `/model`, `/config` and others) open a
  sheet on the phone and are not sent into the conversation.
- The attachment button opens the iOS picker in one tap.
- Send and stop are one button; the effort chip shows the value only.
- Broker sessions name their own entrypoint, so VS Code lists them; transcripts written by earlier versions are
  rewritten after a backup.
- Secret file names are left out of `@` suggestions.

## [0.4.0] - 2026-10-14

### Added

- Model, effort and ultracode follow what Claude Code reports, also when changed in VS Code; an ultracode switch in
  the effort sheet.
- Cards for command results: `/usage` with a bar per limit, `/context` with its breakdown, others as Markdown; the
  `/` palette opens sheets for `/context`, `/usage`, `/cost`, `/stats`, `/mcp` and `/model`.
- File link viewer: links in replies open files within the session's folders, with line anchors, rendered Markdown,
  highlighted code, images, PDFs, JSON and CSV tables. Secret files are blocked, and each read is in the audit log.

### Changed

- Settings are grouped into pages; chip and menu names follow VS Code's.
- The wrapper accepts only `effortLevel` and `ultracode` in remote flag settings.

## [0.3.0] - 2026-10-14

### Added

- Attachments (photos resized for upload, PDFs, text files), `@` file mentions and `/` commands in the composer.
- Edit and Write diffs, subagent activity and a to-do bar in the conversation.
- Session menu: changes with line comments, running tasks with stop, context breakdown, MCP servers (status, on and
  off, reconnect), and rewinding files to a message.
- Web Push notifications for prompts waiting for an answer and for turns sent from the phone that finished.
- Settings: edit Claude Code's settings (allowed keys only, with backups), a compatibility check whenever the VS Code
  extension changes, the audit log, and Enter to send.
- The wrapper resumes a turn cut off by a VS Code window reload, and starts new tabs in the permission mode VS Code
  remembered.

### Security

- Plan approval accepts only its four decisions, and the wrapper refuses any remote answer that would switch to
  `bypassPermissions`.
- `@` suggestions use git's file list only when the git worktree holds the session folder.

## [0.2.0] - 2026-10-14

### Added

- VS Code wrapper (`bin/ccrc-wrapper`, for `claudeCode.claudeProcessWrapper`): sessions open in VS Code can be driven
  from the phone (live view, messages, stop, model, mode, effort, context usage).
- Permission prompts show in VS Code and on the phone; the first answer counts.
- A session the broker runs is handed over when VS Code opens it; a session another process holds opens as a fork.
- VS Code keeps working while the broker is down, and the wrapper reconnects when it returns.
- The wrapper and the broker meet on a private socket in `$XDG_RUNTIME_DIR/ccrc/`, never in `/tmp`.

## [0.1.0] - 2026-10-13

### Added

- Broker on `127.0.0.1:8737`, run as a systemd user service, and a phone web app served through `tailscale serve`.
- Every Claude Code session on the machine, by folder, with its state (running in ccrc, open in VS Code or a terminal,
  inactive).
- Inactive sessions resume when you send a message; new sessions start in folders that have sessions or in `roots`.
- Conversation view with live streaming, tool cards and thinking; cards for permission prompts, questions and plan
  approval; model, permission mode and effort; stop; input queued while Claude works.
- Sessions open in VS Code are shown live, read-only.
- Login with an ID and an Argon2id-hashed password, lockout after repeated failures, one remote login at a time,
  logout after 12 hours idle.
- Only allowed tailnet devices get in; Origin checks, strict cookies and a Content Security Policy;
  `bypassPermissions` cannot be chosen remotely.
- Idle broker session processes close after 15 minutes; an audit log without message contents; light and dark themes.
- `ccrc serve | passwd | status | logout` and `deploy/install-service.sh`.

[Unreleased]: https://github.com/rjs0429/ccrc/compare/v0.7.3...HEAD
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
