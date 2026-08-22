# Third-Party Notices

This distribution (`dsh-subagent-library`) bundles third-party code **inlined into
`lib/index.js`** by the build toolchain (tsdown / rolldown). The list below was
extracted from the shipped bundle's `//#region node_modules/...` comments exactly —
**not from the lockfile** — and each entry's license was verified against the
corresponding `LICENSE` file in the vendored package. Packages that never enter the
bundle (only `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`, which are kept as
external `peerDependencies`) are deliberately not listed.

`lib/client.js` contains **no third-party package code**: the browser side loads
React / React DOM via external `require("react")` from the host runtime, and the
`rolldown:runtime` block is generic bundler-generated helper code, not a package.

## Bundled third-party packages / 进 bundle 的第三方包

| Package | Version | License | Copyright notice（版权声明原文） |
|---|---|---|---|
| `@deepseek-ai/dsh-scope` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-timeout` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-llm` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-session` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-tools` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-subagent` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-settings` | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| `zod` | 4.4.3 | MIT | Copyright (c) 2025 Colin McDonnell |

## Verification / 查证说明

- All 8 packages are **MIT License**. None is Apache-2.0; no upstream package ships a
  `NOTICE` file, so there are no additional NOTICE obligations beyond keeping the
  copyright + permission notice.
- The per-package `LICENSE` texts are reproduced verbatim below (two copyright holders:
  DeepSeek 2026 for the seven `@deepseek-ai/*` packages, Colin McDonnell 2025 for zod).
- `lib/client.js` is excluded from the list by design: React 等浏览器端依赖由宿主运行时以
  外部 `require("react")` 提供，不随本包分发。

## License texts（许可证原文，逐字摘自各上游包 LICENSE 文件）

### MIT License — Copyright (c) 2026 DeepSeek

（`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-timeout`、`@deepseek-ai/dsh-llm`、
`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subagent`、
`@deepseek-ai/dsh-settings` 七个包，文本完全相同）

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT License — Copyright (c) 2025 Colin McDonnell

（`zod`）

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
