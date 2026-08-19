# Bell 🔔

Bell은 AUSG Slack 워크스페이스에서 무료 플랜의 User Group 멘션 제약을 보완하는 작은 그룹 멘션 봇입니다.

```text
@Bell 10기 운영진

🔔 **10기 운영진** — @A @B @C @D
```

그룹과 Slack User ID는 Git 저장소가 아니라 Cloudflare D1 한 곳에 저장하며, `/bell` 모달에서 누구나 관리할 수 있습니다. 관리자·RBAC·별도 웹 UI는 두지 않습니다.

## Architecture

```text
Slack
  │
  │  Events API / Slash Command / Global Shortcut / Interactions
  ▼
Cloudflare Worker
  ├── Slack 서명 검증
  ├── 명령 파싱
  ├── Block Kit / Modal
  └── Slack Web API ──────────────▶ 채널 / ephemeral 메시지
  │
  ▼
Cloudflare D1
  ├── groups
  └── group_members
```

Worker는 다음 세 endpoint만 제공합니다.

| Endpoint | 역할 |
| --- | --- |
| `POST /slack/events` | `url_verification`, `app_mention` |
| `POST /slack/commands` | `/bell` |
| `POST /slack/interactions` | 전역 바로가기, 모달 선택·저장·삭제 |

Events API는 `app_mention`만 구독합니다. `message.channels`처럼 일반 채널 메시지를 모두 받는 이벤트는 사용하지 않습니다.

## 주요 기능

```text
@Bell 10기 운영진
```

해당 그룹의 실제 Slack User ID를 `<@U123ABC>` 형식으로 멘션합니다.
실제 그룹 호출만 채널 전체에 한 줄로 표시되고 멤버에게 알림을 보냅니다.

공지 본문을 같은 메시지에 함께 적을 수도 있습니다.

```text
@Bell 행사팀 오늘 3시에 모여주세요
```

같은 줄에 본문이 이어지면 Bell은 메시지 앞부분과 일치하는 등록 그룹 중 가장 긴 이름을 선택합니다. 예를 들어 `AUSG`와 `AUSG 운영진`이 모두 등록되어 있으면 다음 메시지는 `AUSG 운영진`을 호출합니다.

```text
@Bell AUSG 운영진 오늘 회의합니다
```

Bell은 첫 줄만 명령으로 해석하므로 첫 줄에 그룹명과 본문을 함께 쓰고, 이어서 여러 줄을 더 작성해도 됩니다.

```text
@Bell 행사팀 오늘 3시에 모여주세요
장소는 회의실입니다
늦지 않게 와주세요
```

둘째 줄부터는 그룹 조회에 포함되지 않습니다. 그룹명만 첫 줄에 쓰거나, 첫 줄에 본문을 함께 쓸 수 있습니다.

```text
@Bell 행사팀
오늘 3시에 모여주세요
```

```text
@Bell 행사팀 | 오늘 3시에 모여주세요
```

첫 줄에 본문이 있으면 그 앞부분과 일치하는 등록 그룹 중 가장 긴 이름을 선택합니다. ` | `를 사용하면 구분자 앞부분을 정확한 그룹명으로 조회합니다. 본문은 사용자가 작성한 원래 Slack 메시지에 그대로 남고, Bell은 `🔔 행사팀 — @멤버…` 형식의 멘션 한 줄만 추가합니다. 그룹명이 다른 그룹명의 접두사이거나 본문 첫 단어와 헷갈릴 수 있다면 ` | ` 방식이 가장 명확합니다.

```text
@Bell 목록
@Bell list
```

전체 그룹과 인원 수를 호출자에게만 보여줍니다.

```text
@Bell 10기 운영진 목록
@Bell 10기 운영진 list
```

특정 그룹의 구성원을 실제 멘션 형태로 호출자에게만 보여줍니다.

```text
@Bell help
@Bell 도움말
```

사용법을 호출자에게만 보여줍니다.

```text
/bell

Bell 그룹 관리 (전역 바로가기)
```

동일한 그룹 관리 모달을 엽니다. `/bell`은 Slack의 플랫폼 제한으로 스레드 입력창에서 실행되지 않지만, 전역 바로가기는 메시지 작성기의 바로가기 메뉴나 Slack 검색에서 실행할 수 있습니다. 기존 그룹 선택, 새 그룹 생성, 이름 변경, `multi_users_select`를 이용한 멤버 교체, 확인 후 삭제를 지원합니다. 빈 그룹도 저장할 수 있습니다.

목록·도움말·없는 그룹·빈 그룹 안내는 `chat.postEphemeral`로 보내므로 Bell의 응답은 호출자에게만 보입니다. 다만 `@Bell 목록`처럼 사용자가 채널에 작성한 호출 메시지 자체는 일반 Slack 메시지이므로 채널에 남습니다. 완전히 비공개로 관리하려면 `/bell` 모달을 사용합니다.

`목록`, `list`, `도움말`, `help`와 `… 목록` / `… list`처럼 Bell 명령으로 해석되는 이름은 저장할 수 없습니다. ` | `는 그룹명과 본문의 명시적 구분자로 예약되어 있어 그룹 이름에 넣을 수 없습니다. 그룹 이름은 Unicode NFC와 단일 공백으로 정규화하므로 Modal에서 만든 이름과 Slack 메시지의 이름이 동일하게 조회됩니다.

## Slack App 설정

### 1. OAuth scope

Bot Token Scopes에 다음 세 개만 추가합니다.

```text
app_mentions:read
chat:write
commands
```

`multi_users_select`의 사용자 목록은 Slack이 제공하므로 `users:read`는 필요하지 않습니다. `chat:write.public`도 사용하지 않으며, Bell을 사용할 채널에는 앱을 초대해야 합니다.

scope를 바꾼 뒤에는 워크스페이스에 앱을 다시 설치합니다.

### 2. Events API

Event Subscriptions를 켜고 Request URL을 지정합니다.

```text
https://<WORKER_DOMAIN>/slack/events
```

Subscribe to bot events에는 다음 하나만 추가합니다.

```text
app_mention
```

### 3. Slash Command

Slash Commands에서 `/bell`을 만들고 Request URL을 지정합니다.

```text
https://<WORKER_DOMAIN>/slack/commands
```

### 4. Interactivity

Interactivity & Shortcuts를 켜고 Request URL을 지정합니다.

```text
https://<WORKER_DOMAIN>/slack/interactions
```

같은 화면의 Shortcuts에서 Global Shortcut을 하나 추가합니다.

```text
Name: Bell 그룹 관리
Short Description: Bell 그룹관리 모달을 엽니다
Callback ID: bell_manage_groups
```

Shortcut은 텍스트 명령이 아니므로 별도의 띄어쓰기 alias가 없습니다. 표시 이름에는 `그룹 관리`, 설명에는 `그룹관리`를 사용해 두 표기를 모두 노출합니다. 기존 `commands` scope와 Interactivity Request URL을 그대로 사용하므로 scope 추가나 앱 재설치는 필요하지 않습니다.

## Cloudflare 설정

### 1. D1 생성

Bell용 데이터베이스는 하나만 만듭니다.

```bash
npx wrangler d1 create bell
```

출력된 `database_id`로 [`wrangler.jsonc`](./wrangler.jsonc)의 `00000000-0000-0000-0000-000000000000` placeholder를 교체합니다.

### 2. Secret 등록

실제 값은 소스나 `wrangler.jsonc`에 넣지 않습니다.

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

Slack App의 Bot User OAuth Token과 Basic Information의 Signing Secret을 각각 입력합니다.

## Migration

schema는 [`migrations/0001_initial.sql`](./migrations/0001_initial.sql)에서 관리합니다.

로컬 D1:

```bash
npx wrangler d1 migrations apply bell --local
```

원격 D1:

```bash
npx wrangler d1 migrations apply bell --remote
```

`groups.name`의 `UNIQUE` index와 `group_members(group_id, slack_user_id)`의 복합 Primary Key가 현재 조회를 이미 커버하므로 중복 index는 만들지 않습니다. `group_members`는 복합 Primary Key 자체를 저장 구조로 사용하는 `WITHOUT ROWID` 테이블로 만들어 별도 rowid B-tree도 두지 않습니다.

## Local Development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply bell --local
npm run dev
```

`.dev.vars`에 개발용 Slack App의 값을 넣습니다. 이 파일과 `.env` 계열은 Git에서 제외됩니다.

Slack에서 로컬 Worker를 직접 호출하려면 별도의 공개 HTTPS 터널이 필요합니다. 순수 로직과 D1 동작은 터널 없이 테스트할 수 있습니다.

## 검증

```bash
npm run check
```

다음을 한 번에 확인합니다.

- Wrangler 생성 타입이 최신인지 확인
- TypeScript typecheck
- ESLint와 `no-floating-promises`
- 실제 Workers 런타임 기반 Vitest
- 로컬 D1 migration을 사용한 저장소·모달 테스트

개별 명령도 사용할 수 있습니다.

```bash
npm run cf-typegen
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build`는 `wrangler deploy --dry-run`만 실행하며 원격에 배포하지 않습니다.

## Deploy

대상 Cloudflare 계정과 D1 ID를 확인한 뒤 다음 순서로 진행합니다.

```bash
npm run check
npx wrangler d1 migrations apply bell --remote
npm run deploy
```

배포 후 생성된 Worker URL을 Slack App의 세 Request URL에 반영합니다.

## 요청 검증과 재시도

모든 Slack endpoint는 raw request body, `X-Slack-Signature`, `X-Slack-Request-Timestamp`를 사용해 HMAC SHA-256 서명을 검증합니다. 현재 시각과 5분 넘게 차이 나는 요청은 replay 요청으로 간주해 `401 Unauthorized`로 거부합니다.

Events 요청은 검증 직후 `200`으로 ACK하고 D1 조회와 Slack Web API 전송을 `waitUntil()`에서 처리합니다. Slack이 `X-Slack-Retry-Num`과 함께 다시 보낸 요청은 중복 멘션을 줄이기 위해 처리하지 않고 ACK합니다. Queue·Durable Object·별도 dedup 저장소는 MVP에 추가하지 않았으므로 이 정책은 의도적으로 best-effort입니다.

Slack Web API 요청에는 명시적인 timeout을 둡니다. `chat.postMessage`와 `views.update`가 HTTP `429`를 반환하면 `Retry-After`가 8초 이하일 때 한 번만 재시도합니다. 3초 안에 사용해야 하는 `trigger_id`가 있는 `views.open`은 기다렸다 재시도하지 않고 2초에 중단합니다. 네트워크 오류나 timeout은 중복 메시지를 만들 수 있으므로 자동 재시도하지 않습니다.

## 데이터 모델

```text
bell
├── groups
│   ├── id
│   ├── name
│   ├── created_at
│   └── updated_at
└── group_members
    ├── group_id
    └── slack_user_id
```

그룹 삭제 시 `ON DELETE CASCADE`로 멤버 행도 함께 삭제됩니다. 생성과 수정은 D1 `batch()` 트랜잭션으로 처리합니다. 수정 시 기존 목록 전체를 다시 쓰지 않고, 빠진 멤버만 삭제하고 새 멤버만 추가합니다. 같은 이름 충돌과 이미 삭제된 그룹도 batch 결과와 DB 제약조건으로 판정하므로 사전 조회를 여러 번 하지 않습니다. `/bell` 첫 화면은 그룹 목록과 첫 그룹 상세를 하나의 batch 왕복으로 읽습니다.

### D1 row 비용 특성

- 그룹 호출은 그룹과 멤버를 `LEFT JOIN`한 SQL 한 번으로 읽습니다. 본문이 같은 줄에 있어도 모든 그룹을 읽지 않고, 공백 경계에서 만든 이름 후보만 `groups.name`의 `UNIQUE` index로 조회한 뒤 가장 긴 등록 그룹 하나를 선택합니다.
- 전체 목록은 그룹별 멤버 수를 Primary Key 범위로 세는 SQL 한 번을 사용합니다.
- 그룹 수정은 `groups` 1행을 갱신하고, 멤버는 실제로 빠진 행만 삭제하며 새 행만 삽입합니다. 그대로인 멤버는 다시 쓰지 않습니다. 이름이 그대로면 UNIQUE index 대상인 `name`도 다시 쓰지 않습니다.
- 그룹 생성 시 99개 한도를 원자적으로 지키기 위한 그룹 수 조회가 있지만, 생성은 호출보다 훨씬 드문 관리 작업이고 최대 스캔도 99행입니다.
- 별도 `member_count` 컬럼은 두지 않습니다. 그룹이 최대 99개인 현재 규모에서는 목록을 열 때 `COUNT(*)`로 계산하는 편이 쓰기마다 카운터 정합성을 관리하는 것보다 단순하고 안전합니다.
- 별도 중복 index, KV, Durable Object, Queue는 사용하지 않습니다.

실제 청구용 `rows_read` / `rows_written`은 D1의 실행 통계가 최종 기준이지만, 일반적인 `@Bell 그룹명` 호출은 그룹 1행과 해당 멤버 행만 읽는 경로입니다.

## MVP 범위

구현하지 않은 항목:

- 관리자 권한, RBAC, 그룹 소유권
- Durable Objects, KV, R2, Queues
- Socket Mode, 별도 서버, Express
- GitHub 파일 기반 그룹 데이터
- 웹 관리자 화면, 감사 로그, 통계
- fuzzy search, alias, nested group

Slack 모달의 정적 그룹 선택 메뉴 제한에 맞춰 그룹은 최대 99개, 그룹당 멤버는 최대 100명으로 제한합니다. 99개에 도달하면 새 그룹 선택 항목을 숨기고, 동시 생성도 D1 batch 안에서 거부합니다. AUSG 내부 도구의 실제 규모를 넘게 되면 그때 동적 선택 UI를 검토합니다.

## 참고 문서

- [Slack 요청 서명 검증](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack `app_mention`](https://docs.slack.dev/reference/events/app_mention)
- [Slack Modals](https://docs.slack.dev/surfaces/modals/)
- [Slack `multi_users_select`](https://docs.slack.dev/reference/block-kit/block-elements/multi-select-menu-element/)
- [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare Workers 테스트](https://developers.cloudflare.com/workers/testing/vitest-integration/)
