# Third-party notices

Reviewed against the installed packages and lockfile on **2026-10-01**. The versions below are resolved versions, not dependency range expressions. The project's own code uses the [MIT license](LICENSE); this document does not relicense any dependency.

## Direct runtime dependencies

| Package | Version | Usage | License and original notice |
| --- | --- | --- | --- |
| [IBM Plex Sans variable / Fontsource](https://github.com/fontsource/font-files) | 5.3.0 | Browser font | OFL-1.1 — [complete font notice](public/licenses/IBM-Plex-Sans-OFL-1.1.txt) |
| [IBM Plex Mono / Fontsource](https://github.com/fontsource/font-files) | 5.3.0 | Browser font | OFL-1.1 — [complete font notice](public/licenses/IBM-Plex-Mono-OFL-1.1.txt) |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 1.31.0 | Local stdio and HTTP MCP server | MIT — [license](public/licenses/MCP-SDK-MIT.txt) |
| [https-proxy-agent](https://github.com/TooTallNate/proxy-agents/tree/main/packages/https-proxy-agent) | 9.1.0 | Local server proxy connections | MIT — [license](public/licenses/HTTPS-Proxy-Agent-MIT.txt) |
| [ws](https://github.com/websockets/ws) | 8.21.3 | Local server WebSocket connections | MIT — [license](public/licenses/ws-MIT.txt) |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | 3.4.0 | Local server ZIP archive import | MIT — [license](public/licenses/yauzl-MIT.txt) |
| [Zod](https://github.com/colinhacks/zod) | 4.6.5 | Local MCP tool schemas | MIT — [license](public/licenses/Zod-MIT.txt) |

Original license files are copied without rewriting their text, copyright notices or line endings. Font notices are kept separately because the two packages have different copyright notices. Files under `public/licenses/` accompany Vite's static public assets. The [copy manifest](public/licenses/runtime-license-manifest.json) records source paths and SHA-256 checksums; it is an audit inventory rather than a new license.

The MCP SDK and Zod are used by both [mcp/server.ts](mcp/server.ts) and the local HTTP `/mcp` implementation through [server/agent-bridge.ts](server/agent-bridge.ts) and shared tool definitions. They are not imported by the browser application.

## Immediate runtime dependencies

The copy manifest also covers the 20 distinct immediate required dependency packages of the direct runtime dependencies. It is not an exhaustive verbatim-notice collection of every nested, optional or development dependency, nor a statement that every installed package is loaded on every path. Separately, the [production metadata inventory](public/licenses/production-license-metadata.json) checks declared licenses for the complete 100-snapshot production closure in the lockfile, including required and optional dependency edges.

| Parent | Dependencies with copied original notices |
| --- | --- |
| https-proxy-agent | [agent-base 9.0.0](public/licenses/transitive/agent-base-9.0.0/LICENSE), [debug 4.4.3](public/licenses/transitive/debug-4.4.3/LICENSE) — MIT; `proxy-agent-negotiate` 1.1.0 declares MIT but its installed package contains no standalone license file |
| yauzl | [pend 1.2.0](public/licenses/transitive/pend-1.2.0/LICENSE) — MIT |
| MCP SDK | [json-schema-typed 8.0.2](public/licenses/transitive/json-schema-typed-8.0.2/LICENSE.md) — BSD-2-Clause; [zod-to-json-schema 3.25.2](public/licenses/transitive/zod-to-json-schema-3.25.2/LICENSE) — ISC; the SDK's other immediate dependencies have their MIT files listed in the manifest |

For `proxy-agent-negotiate` 1.1.0, the MIT and author declarations were verified in its installed package, [npm metadata](https://registry.npmjs.org/proxy-agent-negotiate), and the [release source package.json](https://github.com/TooTallNate/proxy-agents/blob/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/negotiate/package.json). The original [upstream package metadata](public/licenses/transitive/proxy-agent-negotiate-1.1.0/UPSTREAM-PACKAGE.json) is preserved as evidence, not as a substitute license. The annotated release tag resolves to commit `b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16`; the integrity-checked npm tarball and the release/current source package directories contain no standalone license text, README or copyright notice. The package declares Nathan Rajlich as its author; no copyright year or permission text has been inferred from that author field. The original-text gap remains explicit, and no sibling-package or generic MIT text has been substituted.

## Lucide — selected icons

Source: [Lucide](https://lucide.dev), package `lucide-static` 1.48.0. The original [vendored notice](src/lib/ui/icons/LUCIDE-LICENSE.txt) and [distribution copy](public/licenses/Lucide-ISC-and-Feather-MIT.txt) retain the ISC license and the MIT notice for Feather-derived icons.

Only the path data of the icons listed in [build-icons.mjs](scripts/design/build-icons.mjs) is vendored into [catalog.ts](src/lib/ui/icons/catalog.ts); no icon runtime is loaded. The cross/trend/ray/extended/horizontal/vertical/channel/fib/pattern/triangle/position/position-short/zone/rectangle/ellipse/indicator/stay/orderbook/watchlist glyphs are authored in this project, not official Lucide icons.

## Removed dependencies and historical records

The Pine editor, script runtime and strategy backtesting implementation have been removed. PineTS, Monaco Editor and the runtime dependencies used only by them are absent from the current dependency manifest and lockfile; their unused license assets have been removed from the current distribution.

The earlier GSAP dock animation was replaced with the browser's Web Animations API. GSAP is also absent from the current runtime inventory. The [dependency review](docs/dependency-license-review-2026-10-01.md) records these scope changes and prior license facts. Older research and validation documents describe historical implementations and are not claims about the current application.
