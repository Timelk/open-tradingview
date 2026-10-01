# 当前运行依赖许可核验 · 2026-10-01

**当前版本已移除 PineTS、Pine 编辑器、脚本执行与策略回测模块。** Monaco Editor 及只由上述模块使用的传递运行依赖也已从包信息、锁文件与发行许可资产中清理。此前“保留 Pine、评估 AGPL 发布”的方案属于已经放弃的实现阶段，不再作为当前版本的发布方案。

维护者提供的 GitHub 仓库已有 MIT `LICENSE`（Copyright (c) 2026 LYJ）。首版源码沿用该原文，同步根目录许可、包信息与 README；未取得或使用 PineTS 商业授权。

## 当前审计范围与结果

- 核对当前全部 **7 个直接运行依赖**与 **20 个第一层必要传递包**，更新 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- 保留仍使用的 **27 份原始许可与版权文件**，逐字节比对安装包/既有来源并记录 SHA-256。两份 IBM Plex 字体分别保留其不同版权通知，Lucide 保留 ISC 与 Feather 派生图标 MIT 通知。来源见 [复制清单](../public/licenses/runtime-license-manifest.json)。
- 删除不再使用的 PineTS/Monaco/DOMPurify/Marked/Acorn/acorn-walk/Astring 许可资产；这些原文不再混入当前发行清单。
- 从锁文件生产入口递归遍历必要和可选依赖边，核对全部 **100 个生产 snapshot** 的许可字段：MIT 88、ISC 7、BSD-3-Clause 2、BSD-2-Clause 1、OFL-1.1 2。当前闭包中没有 PineTS 的 AGPL、DOMPurify 的 MPL/Apache 双许可或 GSAP 的自有许可声明。
- [生产元数据清单](../public/licenses/production-license-metadata.json) 保存锁文件与所读 package.json 的校验值，便于版本变化后复核。它是字段核验，不是逐包法律兼容判断或最终压缩包的完整通知审计。

开发工具不是这份运行闭包的根入口。`esbuild` 仍用于 Vite/研究工具而保留；本轮没有删除通用图表、行情历史、分析回放或内置指标信号的依赖和测试。

## 已核实的直接运行依赖

| 包 | 实际版本 | 包声明许可 | 用途 |
| --- | --- | --- | --- |
| `@fontsource-variable/ibm-plex-sans` | 5.3.0 | OFL-1.1 | 浏览器字体 |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 | 浏览器等宽字体 |
| `@modelcontextprotocol/sdk` | 1.31.0 | MIT | 本地 stdio/HTTP MCP |
| `https-proxy-agent` | 9.1.0 | MIT | 本地服务代理连接 |
| `ws` | 8.21.3 | MIT | 本地服务 WebSocket |
| `yauzl` | 3.4.0 | MIT | 官方 ZIP 成交档案导入 |
| `zod` | 4.6.5 | MIT | 本地 MCP 工具 schema |

准确版权归属与授权正文以 [发行许可文件](../public/licenses/) 为准。没有把不同作者的 MIT 文本替换成通用模板，也没有改写字体或其他许可正文。MCP SDK/Zod 同时用于本地 stdio 和 HTTP `/mcp`，不进入浏览器应用。

## proxy-agent-negotiate 的原文缺口与取证

该包仍由 `https-proxy-agent` 引入。本轮只读取一手来源，没有联系作者。

1. [npm 元数据](https://registry.npmjs.org/proxy-agent-negotiate) 的 1.1.0 记录声明 MIT，作者字段为 Nathan Rajlich，repository 指向 `TooTallNate/proxy-agents` 的 `packages/negotiate` 子目录，homepage 指向同仓库 README。版本发布于 2026-06-08；未提供 `gitHead`，包级 README 数据缺失。
2. 官方 [annotated tag](https://api.github.com/repos/TooTallNate/proxy-agents/git/tags/04af2dd5365059650ad7209cc46457adca9b5ecb) 将 `proxy-agent-negotiate@1.1.0` 指向提交 **`b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16`**。[该提交的 package.json](https://github.com/TooTallNate/proxy-agents/blob/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/negotiate/package.json) 声明相同版本、作者与 MIT；原文件逐字节保存为 [UPSTREAM-PACKAGE.json](../public/licenses/transitive/proxy-agent-negotiate-1.1.0/UPSTREAM-PACKAGE.json)，仅作为声明证据。
3. 官方 [npm tarball](https://registry.npmjs.org/proxy-agent-negotiate/-/proxy-agent-negotiate-1.1.0.tgz) 与元数据 SHA-512 integrity 一致。压缩包只有五个文件：JS、package.json、两个 sourcemap 与类型声明；没有 README、LICENSE、COPYING 或 NOTICE，JS/types 没有补充版权/许可正文。
4. 官方 [发布提交完整树](https://api.github.com/repos/TooTallNate/proxy-agents/git/trees/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16?recursive=1) 未截断。该包目录没有许可文件；同仓库 LICENSE 路径属于其他包。源码与仓库 README 没有补充该包版权行。检查时的 main 树同样没有新增原文，包源码 blob 未变。

**结论：MIT 与作者声明有准确版本的一手证据，独立许可正文/版权行仍缺失于上游。** 没有推断年份、制造版权通知或用兄弟包的 MIT 文本代替。这个具体缺口需要在实际发行通知安排中由维护者判断，不能把 metadata 核对写成原文已齐备。

## 历史阶段的许可事实

以下内容仅解释旧研究、验收与开源准备记录，相关依赖已不在当前实现中。

- **PineTS 0.9.33：** 当时安装包声明 `AGPL-3.0-only`，许可正文与 [固定提交原文](https://github.com/LuxAlgo/PineTS/blob/493a410270b83f94d7504b2eb979deb777e8ced7/LICENSE) 在规范化换行后相同；项目未取得商业授权。[上游商业授权说明](https://github.com/LuxAlgo/PineTS/blob/main/LICENSE-COMMERCIAL.md) 是另外咨询的路线，不是既有授权。
- **Monaco 0.56.0：** 当时包声明 MIT，其 Marked、DOMPurify 与编辑器内部第三方通知已核过；DOMPurify 声明 `(MPL-2.0 OR Apache-2.0)`。当前编辑器及相关资源已删除。
- **GSAP 3.15.0：** 先前使用自有 Standard “No Charge” License，不是 MIT。[官方条款](https://gsap.com/community/standard-license/) 存在用途限制，曾与拟议 AGPL 方案形成需要判断的组合问题；唯一动效已改为原生 `Element.animate()`，依赖已移除。

旧截图、Pine/回测验收数字和源码链接描述的是其记录日期的实现，不能当作当前功能或当前许可资产。后续若自研回测或重新引入任何外部执行引擎，需要重新核对许可与发布范围。

## 维护者待决定与发布前核对

1. 项目沿用维护者仓库已有的 MIT 许可；继续保留第三方代码、图标和字体各自的版权与许可通知。
2. 明确首发是源码仓库、构建下载还是本地服务器发行包，核对实际发行内容的版权通知与许可文件。
3. 判断 `proxy-agent-negotiate` 的缺失原文如何处理；本轮已有明确版本、作者、声明和来源证据，没有许可正文。
4. 按实际产物检查更深层通知的保留。完整闭包的 metadata 已核对，仍未逐一复制所有深层、开发工具、可选 peer 与操作系统组件的原文，不能据此宣布“所有许可审计通过”。
