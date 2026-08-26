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

- **생태계가 딸려 온다.** Claude Code의 도구, 권한 모델, 세션, 스킬, 플러그인은 하네스의 것이고
  우리가 다시 얻어낼 대상이 아니다.
- **청구서를 결정한다.** Claude Code를 하네스로 구동하면 Claude Code 구독으로 돈다. 직접 만든 루프를
  Messages API에 물리면 같은 일을 토큰 단위로 청구한다.

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

**구현된 것은 없다.** 현재 이 저장소에는 툴체인, 라이선스, CI 게이트, 그리고 아무것도 export 하지 않는
빈 `@pleaseai/core`만 있다. 우연히 생긴 표면이 확정된 것처럼 인용되는 일을 막으려고 일부러 비워 뒀다.

정해진 것: 위 범위 표, 이름, 라이선스(Apache-2.0), 스택([Bun](https://bun.sh), TypeScript,
[Turborepo](https://turborepo.com)).

정해지지 않은 것: **모든 API.** 에이전트를 어떻게 선언하는지, 프로젝트 레이아웃이 컨벤션 기반인지
설정 기반인지, 워크플로를 어떻게 표현하는지, 채널 핸들러가 무엇을 받는지, 샌드박스 프로바이더를
어떻게 고르는지, eval을 어떻게 쓰는지. 설계 논의는 이슈에서 한다.

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
  core/           # @pleaseai/core — 플레이스홀더, 아직 아무것도 export 하지 않는다
docs/
  prior-art.md    # eve, flue, AI SDK 하네스가 이미 하고 있는 것
```

## 선행 사례

[`docs/prior-art.md`](docs/prior-art.md)는 eve와 flue가 실제로 무엇을 하는지 — 각자의 공식 문서에서,
날짜와 함께 — 기록한다. 여기서의 설계 논의가 기억이 아니라 존재하는 것에서 출발하도록.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고. [행동 강령](CODE_OF_CONDUCT.md)과, 취약점 제보는
[SECURITY.md](SECURITY.md)도 함께 읽어 주세요.

## 라이선스

[Apache-2.0](LICENSE) © Passion Factory
