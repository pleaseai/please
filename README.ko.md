# please

[![CI](https://github.com/pleaseai/please/actions/workflows/ci.yml/badge.svg)](https://github.com/pleaseai/please/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

[English](README.md) | 한국어

[pleaseai](https://github.com/pleaseai)의 에이전트 프레임워크입니다.

## 상태

**이 저장소는 아직 스캐폴드입니다.** 툴체인, 라이선스, CI 게이트, 그리고 비어 있는
`@pleaseai/core` 패키지만 들어 있습니다.

프레임워크 자체는 아직 설계되지 않았습니다. API, 기능 범위, 아키텍처, 확장 지점 모두
**미정**입니다. 이 저장소의 어떤 내용도 그에 대한 확정으로 읽어서는 안 됩니다.
`packages/core/src/index.ts`는 확정되지 않은 표면이 확정된 것처럼 인용되는 일을 막기 위해
의도적으로 아무것도 내보내지 않습니다.

**확정된 것:**

- 이름(`please`)과 org(`pleaseai`).
- 에이전트 프레임워크를 지향한다는 것.
- 라이선스: Apache-2.0.
- 스택: [Bun](https://bun.sh), TypeScript, [Turborepo](https://turborepo.com).

나머지는 모두 열려 있습니다. 설계 논의는 이슈에서 진행합니다.

## 요구 사항

- [Bun](https://bun.sh) — 버전은 [`mise.toml`](mise.toml)에 고정되어 있습니다.
- 선택적으로 [mise](https://mise.jdx.dev) — 고정된 버전을 대신 설치해 줍니다.

## 시작하기

```bash
git clone https://github.com/pleaseai/please.git
cd please

mise install   # 고정된 bun 버전 설치 (직접 관리한다면 건너뛰어도 됩니다)
bun install    # 의존성 설치
```

## 명령어

```bash
bun run lint        # 린트 (자동 수정은 bun run lint:fix)
bun run type-check  # 전체 패키지 타입 체크
bun run test        # 테스트 실행
bun run build       # 전체 패키지 빌드

mise run ci         # lint + type-check + test + build
```

## 구조

```
packages/
  core/       # @pleaseai/core — 플레이스홀더, 아직 아무것도 내보내지 않습니다
```

## 기여하기

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요. [행동 강령](CODE_OF_CONDUCT.md)도 함께 읽어
주시고, 보안 취약점은 [SECURITY.md](SECURITY.md)의 절차를 따라 주세요.

## 라이선스

[Apache-2.0](LICENSE) © Passion Factory
