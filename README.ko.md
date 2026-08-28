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

딸려 오지 **않는** 것도 기록에 남아 있다. 스킬은 디렉터리에서 읽히는 대신 인라인 객체로 넘겨야 한다.
어댑터 *설정*에는 훅이 없고 권한 모드도 셋뿐이다 — 다만 설정만이 들어가는 길은 아니다. 세션 작업
디렉터리에 심은 `.claude/settings.json`은 실제로 읽히고, 실행 프로브가 그 두 가지 결과를 측정했다.
거기 선언한 훅은 실행되고, 거기 쓴 `deny` 규칙은 어댑터의 권한 모드를 덮어쓴다 — 런타임에 권한 검사를
아예 건너뛰라고 요청하는 모드까지 포함해서다. [`docs/project-layout.md`](docs/project-layout.md) 참고.

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

**프레임워크 API는 아직 설계되지 않았다.** `@pleaseai/core`의 루트 export는 일부러 비어 있다. 우연히
생긴 표면이 확정된 것처럼 인용되는 일을 막기 위해서다.

한 계층만 존재한다. 열린 질문들을 그것 없이는 답할 수 없었기 때문이다 — **샌드박스**다. 루트가 아니라
전용 서브패스로만 닿는다.

| 서브패스 | 무엇인가 |
| --- | --- |
| `@pleaseai/core/sandbox` | 백엔드 계약 — 벤더 중립 타입 |
| `@pleaseai/core/sandbox/harness` | 그 계약을 AI SDK `HarnessV1SandboxProvider`로 옮긴 것. 모든 백엔드를 위해 한 번만 작성한다 |
| `@pleaseai/core/sandbox/docker` | 로컬 Docker 백엔드. **호스트 전용** — `docker` CLI를 실행하므로 Worker 번들에 들어가면 안 된다 |
| `@pleaseai/core/sandbox/local` | 호스트 프로세스 백엔드 — 데몬도 이미지도, **격리도 없다**. 같은 이유로 호스트 전용 |

하네스 변환을 백엔드에서 떼어 둔 덕분에 두 번째 백엔드가 그것을 다시 만들 필요가 없고, 서브패스는
호스트 전용 코드가 그것을 실행할 수 없는 타깃으로 새어 들어가지 않게 막는다.

정해진 것: 위 범위 표, 이름, 라이선스(Apache-2.0), 스택([Bun](https://bun.sh), TypeScript,
[Turborepo](https://turborepo.com)), 그리고 위의 샌드박스 분리.

정해지지 않은 것: **나머지 API.** 에이전트를 어떻게 선언하는지, 프로젝트 레이아웃이 컨벤션 기반인지
설정 기반인지, 워크플로를 어떻게 표현하는지, 채널 핸들러가 무엇을 받는지, eval을 어떻게 쓰는지. 설계 논의는
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
  core/                      # @pleaseai/core — 루트 export는 일부러 비어 있다
    src/sandbox/
      contract/              # 백엔드 계약
      harness/               # 그 계약 위의 HarnessV1SandboxProvider
      docker/                # 로컬 Docker 백엔드 (호스트 전용)
      local/                 # 호스트 프로세스 백엔드 (호스트 전용, 격리 없음)
    scripts/                 # 런타임을 가정하지 않고 측정하는 프로브
docs/
  prior-art.md               # eve, flue, AI SDK 하네스가 이미 하고 있는 것
  project-layout.md          # 레이아웃 제안과, 그것이 기다리는 열린 질문들
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

[`docs/project-layout.md`](docs/project-layout.md)은 그 기록 위에 세운 첫 번째 논증이다. 제안 레이아웃,
계약이 이미 우리 대신 정해 버린 것들, 그리고 아직 열려 있는 질문들.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고. [행동 강령](CODE_OF_CONDUCT.md)과, 취약점 제보는
[SECURITY.md](SECURITY.md)도 함께 읽어 주세요.

## 라이선스

[Apache-2.0](LICENSE) © Passion Factory
