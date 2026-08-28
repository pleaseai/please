# please

[![CI](https://github.com/pleaseai/please/actions/workflows/ci.yml/badge.svg)](https://github.com/pleaseai/please/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

[English](README.md) | 한국어

**자체 에이전트 루프를 만들지 않는** 에이전트 프레임워크.

`please`는 이미 있는 코딩 에이전트 하네스 — Claude Code, OpenCode, Pi — 를 런타임으로 돌리고,
하네스가 아무 의견도 갖지 않는 것들을 채운다. 어디서 실행되는지, 어떻게 도달하는지, 그리고 작업이
어떻게 순서를 지키며 크래시를 견디는지.

## 왜 하네스를 재사용하나

이 분야의 프레임워크들([eve](https://eve.dev), [flue](https://flueframework.com))은 모델을 직접
구동하면서 그 주변의 에이전트를 다시 만든다 — 도구 세트, 권한 프롬프트, 세션과 재개, 컨텍스트 압축.
그건 코딩 에이전트에서 이미 좋고, 이미 업스트림에서 관리되고, 이걸 쓸 사람들에게 이미 익숙한 부분이다.
다시 구현하면 원본을 영원히 쫓아가야 할 의무를 진 열등한 사본이 나온다.

하네스를 재사용하면 따라오는 것이 둘 있다.

- **생태계가 상당 부분 딸려 온다.** 내장 도구, 네이티브 대화 상태와 컨텍스트 압축, 세션과 재개,
  지속형 워크플로 스테핑은 하네스의 것이고 우리가 다시 얻어낼 대상이 아니다.
- **청구서를 결정한다.** Claude Code를 하네스로 구동하면 Claude Code 구독으로 돈다. 직접 만든 루프를
  Messages API에 물리면 같은 일을 토큰 단위로 청구한다.

딸려 오지 **않는** 것도 기록에 남아 있고, 그 목록은 계속 줄어들고 있다. 어댑터 *설정*에는 훅도 스킬도
서브에이전트도 없고 권한 모드도 셋뿐이다 — 다만 설정은 들어가는 길이 아니다. 런타임은 그것들을 세션
작업 디렉터리의 `.claude/` 에서 읽는다. 이미 있는 Claude Code 프로젝트는 거기 놓이는 것만으로 그대로
넘어오고, 어댑터의 인라인 `skills` 옵션은 결국 같은 파일을 써 주는 껍데기다. 실행 프로브가 그중 둘을
측정했다 — 거기 선언한 훅은 실행되고, 거기 쓴 `deny` 규칙은 어댑터의 권한 모드를 덮어쓴다. 런타임에
권한 검사를 아예 건너뛰라고 요청하는 모드까지 포함해서다. 나머지는 Agent SDK 자체 문서가 답한다.
[`docs/project-layout.md`](docs/project-layout.md) 참고.

하네스 경계 자체도 우리 것이 아니다 — AI SDK의
[harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)와
[harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters) 계약이고, 세션·스트림
이벤트·도구·사용량·수명주기를 런타임 간에 이미 정규화한다. `please`는 `HarnessAgent`를 **둘러싸고**
짓는 것이지 그것과 경쟁하는 물건이 아니다.

## 범위

아래는 **범위**이지 API가 아니다. 구현된 것은 없고 확정된 시그니처도 없다 — [상태](#상태) 참고.

| 축 | 계획 |
| --- | --- |
| **하네스** | Claude Code, OpenCode (둘 다 샌드박스 브리지), Pi (호스트 프로세스) — `@ai-sdk/harness` 경유 |
| **배포 타깃** | Cloudflare, Vercel |
| **샌드박스** | Cloudflare Sandbox, [e2b](https://e2b.dev), [Daytona](https://daytona.io), Vercel Sandbox |
| **채널** | Slack, GitHub, Linear |
| **워크플로** | 에이전트 턴을 감싸는 내구성 오케스트레이션 — dispatch, 재개, 순서 보장 |

축을 저기에 그은 이유 네 가지.

**하네스.** AI SDK의 어댑터 목록은 더 넓다 (Codex, Cursor, Cline, Deep Agents, fx, Grok Build, 그리고
예정으로 Amp·Goose·Mastra). 셋은 출발점이지 상한이 아니다 — 계약이 어댑터 단위라 추가는 아키텍처가
아니라 테스트의 문제다. Claude Code와 OpenCode는 샌드박스 브리지 뒤에서 돌기 때문에 네트워크가 되는
샌드박스가 필요하고, Pi는 호스트 프로세스에서 돌기 때문에 필요 없다.

**타깃.** Cloudflare와 Vercel 둘 다 일급이다 — 하나가 진짜고 하나가 포팅인 구조가 아니다. 둘은 서로
다르게 실패한다. Worker는 플랫폼이 복구를 관리해 주고 호출당 CPU 한도를 갖는 반면, Node 형태의 배포는
진짜 파일시스템을 갖고 재시작 정합성을 스스로 책임진다. 한쪽을 진짜 타깃으로, 다른 쪽을 나중 일로
취급하는 프레임워크는 그 비대칭을 모든 기능에 흘린다.

**샌드박스.** 프로바이더 넷인 이유는, 브리지 하네스가 진짜 프로세스를 돌리고 포트를 열 수 있는
샌드박스를 요구하고 프로바이더들이 갈리는 지점이 정확히 거기이기 때문이다. 샌드박스 계약을 두는
목적 자체가 이 선택을 배포 시점의 결정으로 남겨두는 것이다.

**채널.** Slack, GitHub, Linear — 나중에 붙인 채팅 표면이 아니라 실제로 일이 할당되는 곳. 인바운드
형태가 충분히 다르기 때문에(서명된 웹훅, 이벤트 스트림, 소켓) 하나인 척하는 순간 추상화가 어긋난다.

## 상태

**API의 일부는 설계됐고, 위 범위의 대부분은 아직이다.** 존재하는 것은 일부러 작고, 실제로 돈다 —
[`examples/claude-code-docker`](examples/claude-code-docker)가 그 위에서 진짜 턴을 구동한다.

| 서브패스 | 무엇인가 |
| --- | --- |
| `@pleasedev/core` | `defineAgent` — 하네스 어댑터, 샌드박스, 그리고 그 안으로 실어 나르는 워크스페이스 디렉터리 |
| `@pleasedev/core/sandbox` | `defineSandbox`와 백엔드 계약 — 벤더 중립 타입 |
| `@pleasedev/core/sandbox/harness` | 그 계약을 AI SDK `HarnessV1SandboxProvider`로 옮긴 것. 모든 백엔드를 위해 한 번만 작성한다 |
| `@pleasedev/core/sandbox/docker` | 로컬 Docker 백엔드. **호스트 전용** — `docker` CLI를 실행하므로 Worker 번들에 들어가면 안 된다 |

하네스 변환을 백엔드에서 떼어 둔 덕분에 두 번째 백엔드가 그것을 다시 만들 필요가 없고, 서브패스는
호스트 전용 코드가 그것을 실행할 수 없는 타깃으로 새어 들어가지 않게 막는다.

여기서 API보다 중요한 것은 두 가지 모양이다. **하네스 어댑터는 감싸지 않는다.** `createClaudeCode()`는
`@ai-sdk/harness-claude-code`에서 와서 그대로 전달된다. 그 경계는 AI SDK의 것이고, 여기서 한 겹 두르면
그것을 영영 쫓아다닐 의무만 생긴다. 그리고 **`workspace`는 선언된 입력이다.** 어떤 어댑터도 `agents`,
`skills`, `settingSources` 를 노출하지 않으므로, 그 기능들이 실행에 닿는 길은 디렉터리 하나뿐이기
때문이다.

정해진 것: 위 범위 표, 이름, 라이선스(Apache-2.0), 스택([Bun](https://bun.sh), TypeScript,
[Turborepo](https://turborepo.com)), 샌드박스 분리, 그리고 선언 문법 — 컴파일러가 필요한 디렉티브가
아니라 `defineAgent` / `defineSandbox`. 근거는 [`docs/project-layout.md`](docs/project-layout.md)에 있다.

정해지지 않은 것: **나머지 대부분.** 워크플로를 어떻게 표현하는지, 채널 핸들러가 무엇을 받는지, eval을
어떻게 쓰는지, 파일시스템이 없는 타깃을 위해 워크스페이스를 어느 단계에서 번들에 인라인하는지. 설계 논의는
[Discussions](https://github.com/pleaseai/please/discussions/categories/ideas)에서 한다. 이슈는 버그 보고용이다.

## 요구사항

- [Bun](https://bun.sh) — 버전은 [`mise.toml`](mise.toml)에 고정돼 있다.
- 선택적으로 [mise](https://mise.jdx.dev) — 고정된 버전을 대신 설치해 준다.

## 시작하기

```bash
git clone https://github.com/pleaseai/please.git
cd please

mise install   # 고정된 bun 버전 설치 (bun을 직접 관리하면 건너뛴다)
bun install    # 의존성 설치
```

## 명령어

```bash
bun run lint        # 린트 (자동 수정은 bun run lint:fix)
bun run type-check  # 전체 패키지 타입 검사
bun run test        # 테스트 실행
bun run build       # 전체 패키지 빌드

mise run ci         # lint + type-check + test + build
```

## 레이아웃

```
packages/
  core/                      # @pleasedev/core
    src/
      agent/                 # defineAgent, 그리고 세션으로 들어가는 워크스페이스 경로
      sandbox/
        contract/            # 백엔드 계약
        harness/             # 그 계약 위의 HarnessV1SandboxProvider
        docker/              # 로컬 Docker 백엔드 (호스트 전용)
    scripts/                 # 런타임을 가정하지 않고 측정하는 프로브
  cli/                       # @pleasedev/cli — 아직 배포하지 않는다. 명령어가 없다
    src/ui/                  # 세션이 시작되기 전에 `please dev`가 그리는 부팅 크롬
examples/
  claude-code-docker/        # 로컬 컨테이너 안의 Claude Code. 위 API로 작성됐다
docs/
  prior-art.md               # eve, flue, AI SDK 하네스, Agent SDK가 이미 하고 있는 것
  project-layout.md          # 레이아웃 논증, 정해진 것, 아직 열린 것
  dev-tui.md                 # `please dev`: 정해진 것과, 아직 기다리는 것
```

예제는 실행할 수 있고, 이 프레임워크가 무엇을 하고 무엇을 하지 않는지 보는 가장 짧은 길이다.

```bash
bun run examples/claude-code-docker/index.ts   # Docker와 Anthropic 자격 증명이 필요하다
```

`packages/core/scripts/` 아래 세 프로브는 실행할 수 있고, 각각 문서가 아니면 추측에 그쳤을 질문에
답한다.

```bash
bun run packages/core/scripts/probe-adapter-bootstrap.ts  # 자격 증명 불필요
bun run packages/core/scripts/probe-claude-dir.ts         # Anthropic 자격 증명 필요
bun run packages/core/scripts/probe-permissions.ts        # Anthropic 자격 증명 필요
```

## 선행 사례

[`docs/prior-art.md`](docs/prior-art.md)는 eve, flue, 그리고 AI SDK 하네스 계약이 실제로 무엇을 하는지
— 각자의 공식 문서에서, 날짜와 함께 — 기록한다. 여기서의 설계 논의가 기억이 아니라 존재하는 것에서
출발하도록.

[`docs/project-layout.md`](docs/project-layout.md)은 그 기록 위에 세운 논증이다. 계약이 이미 우리 대신
정해 버린 것들, 선언 문법이 디렉티브가 아니라 함수인 이유, 그리고 아직 열려 있는 질문들.

[`docs/dev-tui.md`](docs/dev-tui.md)은 그 위에 얹힌 논증이다. 대화형 `please dev`가 터미널을
[`@ai-sdk/tui`](https://ai-sdk.dev/docs/ai-sdk-harnesses/terminal-ui)와 eve에서 이식한 부팅 크롬
사이에 어떻게 나누는지, 그리고 그 명령어가 아직 어떤 `defineAgent` 결정을 기다리고 있는지.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고. [행동 강령](CODE_OF_CONDUCT.md)과, 취약점 제보는
[SECURITY.md](SECURITY.md)도 함께 읽어 주세요.

## 라이선스

[Apache-2.0](LICENSE) © Passion Factory
