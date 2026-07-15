# Changelog

## [0.9.4](https://github.com/introspection-org/pi-recipes/compare/v0.9.3...v0.9.4) (2026-07-15)


### Bug Fixes

* reduce MCP client process overhead ([#76](https://github.com/introspection-org/pi-recipes/issues/76)) ([0633059](https://github.com/introspection-org/pi-recipes/commit/063305921d8e307dc49012a40b2b834c4eb45ad7))

## [0.9.3](https://github.com/introspection-org/pi-recipes/compare/v0.9.2...v0.9.3) (2026-07-14)


### Bug Fixes

* resolve recipe extension package aliases ([#74](https://github.com/introspection-org/pi-recipes/issues/74)) ([c3c1caa](https://github.com/introspection-org/pi-recipes/commit/c3c1caa60997c1dd9f47f04a209aca4860db6703))

## [0.9.2](https://github.com/introspection-org/pi-recipes/compare/v0.9.1...v0.9.2) (2026-07-14)


### Bug Fixes

* persist MCP runtime across commands ([18600f1](https://github.com/introspection-org/pi-recipes/commit/18600f1fc0705f5ad9614af4e1a1f8629ad3a319))

## [0.9.1](https://github.com/introspection-org/pi-recipes/compare/v0.9.0...v0.9.1) (2026-07-14)


### Bug Fixes

* avoid nested MCP CLI processes ([#65](https://github.com/introspection-org/pi-recipes/issues/65)) ([f2848e7](https://github.com/introspection-org/pi-recipes/commit/f2848e7ea1b29b8155a10cc5627bdcc8fc473705))
* separate package release pull requests ([#66](https://github.com/introspection-org/pi-recipes/issues/66)) ([dbbd048](https://github.com/introspection-org/pi-recipes/commit/dbbd048d024fb71a168085de8e4c905434ec6da2))

## [0.9.0](https://github.com/introspection-org/pi-recipes/compare/v0.8.0...v0.9.0) (2026-07-13)


### Features

* lazily discover MCP tools per session ([#63](https://github.com/introspection-org/pi-recipes/issues/63)) ([f8fedf0](https://github.com/introspection-org/pi-recipes/commit/f8fedf0a466ffa25ab22c96bc22b82a48a2e562d))

## [0.8.0](https://github.com/introspection-org/pi-recipes/compare/v0.7.1...v0.8.0) (2026-07-12)


### Features

* **recipe-check:** storage in the resources grammar + deployment-configuration spec ([#59](https://github.com/introspection-org/pi-recipes/issues/59)) ([a5623b9](https://github.com/introspection-org/pi-recipes/commit/a5623b99aea36537a309d99cc87949e5a0878333))

## [0.7.1](https://github.com/introspection-org/pi-recipes/compare/v0.7.0...v0.7.1) (2026-07-12)


### Bug Fixes

* **pi-recipe-check:** add pure resources validation module ([#56](https://github.com/introspection-org/pi-recipes/issues/56)) ([c3a78cd](https://github.com/introspection-org/pi-recipes/commit/c3a78cdfdd880d3aca672bb28b98937a3d532dc9))

## [0.7.0](https://github.com/introspection-org/pi-recipes/compare/v0.6.4...v0.7.0) (2026-07-12)


### Features

* **pi-recipe-check:** extract pure validation core and prepare crates.io publishing ([#54](https://github.com/introspection-org/pi-recipes/issues/54)) ([d5147c0](https://github.com/introspection-org/pi-recipes/commit/d5147c05c59907de783e5cb7e86a78287fab546a))

## [0.6.4](https://github.com/introspection-org/pi-recipes/compare/v0.6.3...v0.6.4) (2026-07-12)


### Bug Fixes

* make MCP metadata and invocation token-efficient ([7b3136c](https://github.com/introspection-org/pi-recipes/commit/7b3136cc0415c0c6c9f43d4982e75c04f411978d))
* mark MCP CLI network calls for trace baggage ([1486454](https://github.com/introspection-org/pi-recipes/commit/148645458706d6746fc25ce996dfcc892d717556))

## [0.6.3](https://github.com/introspection-org/pi-recipes/compare/v0.6.2...v0.6.3) (2026-07-11)


### Bug Fixes

* Remove implicit system prompt additions ([#48](https://github.com/introspection-org/pi-recipes/issues/48)) ([9bf3b4b](https://github.com/introspection-org/pi-recipes/commit/9bf3b4b87f39ab03fd3afa3af06a16b1bf768e00))

## [0.6.2](https://github.com/introspection-org/pi-recipes/compare/v0.6.1...v0.6.2) (2026-07-11)


### Bug Fixes

* include MCP CLI help in npm package ([#45](https://github.com/introspection-org/pi-recipes/issues/45)) ([952a2ab](https://github.com/introspection-org/pi-recipes/commit/952a2abb10fc6318a435764568ffdece1b6828b7))

## [0.6.1](https://github.com/introspection-org/pi-recipes/compare/v0.6.0...v0.6.1) (2026-07-10)


### Bug Fixes

* add a capability-scoped MCP CLI for recipe agents ([#44](https://github.com/introspection-org/pi-recipes/issues/44)) ([c48a519](https://github.com/introspection-org/pi-recipes/commit/c48a5198558eaf377f7ce6310a51b4e6cc0f55a8))

## [0.6.0](https://github.com/introspection-org/pi-recipes/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* add explicit per-server MCP tool selection ([#40](https://github.com/introspection-org/pi-recipes/issues/40)) ([8a1ee0f](https://github.com/introspection-org/pi-recipes/commit/8a1ee0f96facc56308771b1315dd24c5e2cc0902))
* improve MCP capability disclosure ([7bc380c](https://github.com/introspection-org/pi-recipes/commit/7bc380c474c83b802cb2821983701686de95aa8f))


### Bug Fixes

* enforce recipe agent tool allowlists ([7d86939](https://github.com/introspection-org/pi-recipes/commit/7d8693925a3523022e9c7aef76c0ee250f34494b))
* warn when MCP agents omit bash ([75b5586](https://github.com/introspection-org/pi-recipes/commit/75b5586c40d60e64ca1db34fd32cd5b596aee13b))

## [0.5.0](https://github.com/introspection-org/pi-recipes/compare/v0.4.1...v0.5.0) (2026-07-09)


### Features

* recipe agent model config (stream options, provider routing) ([1f0afc8](https://github.com/introspection-org/pi-recipes/commit/1f0afc83fab2af303c295b8abbc9ff3dd7a1cdd4))
* shared mcp CLI prompt section and skillsDeclared flag ([7fe5a08](https://github.com/introspection-org/pi-recipes/commit/7fe5a085c5f322d63015884f5ef8ea91d4cb622c))


### Bug Fixes

* build CLI artifacts before tests ([a22e748](https://github.com/introspection-org/pi-recipes/commit/a22e7485ba1848b2bb5bce9d46569c7dfa8ecfe4))
* detect symlinked mcp CLI entry so pnpm and bin-shim launches run ([67e69d1](https://github.com/introspection-org/pi-recipes/commit/67e69d1d7dcb77389f4a29485f0cbdd38245e035))
* name bootstrap MCP servers from serverInfo and the endpoint label ([52b60ac](https://github.com/introspection-org/pi-recipes/commit/52b60accdc5cf32159ca91aa6e3ba311eb25059e))
* validate agent MCP refs against recipe policy ([ed20943](https://github.com/introspection-org/pi-recipes/commit/ed209431163fac21cc7ec16b20b87e0d3285a05c))

## [0.4.1](https://github.com/introspection-org/pi-recipes/compare/v0.4.0...v0.4.1) (2026-07-09)


### Bug Fixes

* pack child-agent-completions and guard packed module imports ([#31](https://github.com/introspection-org/pi-recipes/issues/31)) ([3f1ee31](https://github.com/introspection-org/pi-recipes/commit/3f1ee311955dab0087d33bd841cd71f842b0fa76))

## [0.4.0](https://github.com/introspection-org/pi-recipes/compare/v0.3.0...v0.4.0) (2026-07-09)


### ⚠ BREAKING CHANGES

* the `mcp tools sources|search|describe` and JSON-args `mcp call` command surface is replaced by mcporter's CLI. The `main`, `callMcpTool`, `localMcpHeadersForServer`, and `mcpCliEntrypointPath` exports are removed (`mcporterCliEntrypointPath` replaces the latter). `dist/mcp.js` is no longer an executable entrypoint. mcporter declares engines node >=24; Node 24+ is recommended (0.12.3 verified working on Node 22).

### Features

* add mcp search and run helpers ([73a0edb](https://github.com/introspection-org/pi-recipes/commit/73a0edb269d56c6c00725d5cfb04c84e674c0c67))
* mcp run --var KEY=value for safe dynamic values in code mode ([7a5bfb4](https://github.com/introspection-org/pi-recipes/commit/7a5bfb40b3c7189eae7043713aefdba4e388e34f))
* replace the bundled mcp CLI with mcporter ([d512d4b](https://github.com/introspection-org/pi-recipes/commit/d512d4b48ed1b0c072cd84852eba7de136cd4f62))
* show tool output schemas in mcp list --schema ([fb3d151](https://github.com/introspection-org/pi-recipes/commit/fb3d151a4f19d671758ca67a25a23910c4c5bae8))
* trigger patch release ([731aeca](https://github.com/introspection-org/pi-recipes/commit/731aecab39c54d7197e942204d8bd52a45a82cea))


### Bug Fixes

* agent-friendly mcp CLI error paths ([81d476b](https://github.com/introspection-org/pi-recipes/commit/81d476b1ea49b4ec511bb1392b91ebc78ce136f1))
* brand delegated mcp cli output consistently ([1f93178](https://github.com/introspection-org/pi-recipes/commit/1f931788df6335bba3cfd3d39dd4b5356bba24a2))
* hide upstream mcp cli version banner ([b5b697a](https://github.com/introspection-org/pi-recipes/commit/b5b697ade53ec7a7a0735e1b25bb43cb642603b7))
* hint at bearer-token expiry behind OAuth metadata errors ([d2c7f1c](https://github.com/introspection-org/pi-recipes/commit/d2c7f1c28d818563eab3717bb36ad16dddcd71db))
* report invalid mcp search regex ([dc10369](https://github.com/introspection-org/pi-recipes/commit/dc10369cc701bf537f00c24f3a0587a20f6e4933))


### Miscellaneous Chores

* release 0.4.0 ([2289154](https://github.com/introspection-org/pi-recipes/commit/2289154656e672df51e1aa691692b0c025fc58a9))

## [0.3.0](https://github.com/introspection-org/pi-recipes/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* release recipe interaction helpers ([5937e8a](https://github.com/introspection-org/pi-recipes/commit/5937e8a3ee9fe4d2442254253467ddec7775dde1))

## [0.2.0](https://github.com/introspection-org/pi-recipes/compare/v0.1.0...v0.2.0) (2026-07-08)


### Features

* add Harbor recipe evals ([9b742c3](https://github.com/introspection-org/pi-recipes/commit/9b742c39595610677c1814ec1f69fe032b9e1c96))
* add recipe check validator ([af8a76c](https://github.com/introspection-org/pi-recipes/commit/af8a76c74947f7c4f6d964ed737552d34a2daaec))
* simplify recipe telemetry contract ([6d6154c](https://github.com/introspection-org/pi-recipes/commit/6d6154c3ffb1aa7926669d3d0f7a4b028f6f8f7a))
* validate recipe model spec format and migrate to pi-ai compat entrypoint ([#18](https://github.com/introspection-org/pi-recipes/issues/18)) ([d129aca](https://github.com/introspection-org/pi-recipes/commit/d129aca97cc5f40df9b4870d9726a74e312855b8))


### Bug Fixes

* install Harbor eval recipes from writable copy ([0af06a3](https://github.com/introspection-org/pi-recipes/commit/0af06a38dddc25b772fda5c19ca312ec41793e6f))

## [0.1.0](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.2...v0.1.0) (2026-06-30)


### Bug Fixes

* count install telemetry once per recipe ([fe92eaf](https://github.com/introspection-org/pi-recipes/commit/fe92eaf848c010da5c50f96a8a29658aedb68a82))


### Miscellaneous Chores

* release 0.1.0 ([c7a2774](https://github.com/introspection-org/pi-recipes/commit/c7a2774fa4766ab81ef626534444effc2838276a))

## [0.1.0-beta.2](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.1...v0.1.0-beta.2) (2026-06-28)


### Features

* add session-scoped MCP support ([2bb532a](https://github.com/introspection-org/pi-recipes/commit/2bb532a309bff3f96180921e3caab9474ddb4ec6))


### Bug Fixes

* keep recipe MCP manifests scoped to exposed tools ([2d0ca2c](https://github.com/introspection-org/pi-recipes/commit/2d0ca2c91cd857e08336b54dbce22ff772a6a917))

## [0.1.0-beta.1](https://github.com/introspection-org/pi-recipes/compare/v0.1.0-beta.0...v0.1.0-beta.1) (2026-06-27)


### ⚠ BREAKING CHANGES

* recipe manifests no longer support theme resources, and the Pi extension no longer exposes recipe themePaths.

### Features

* remove recipe theme resources ([#8](https://github.com/introspection-org/pi-recipes/issues/8)) ([032cd3b](https://github.com/introspection-org/pi-recipes/commit/032cd3bb6d0f5d0272af99de73f1e29ed31f707e))
* send anonymous install telemetry to the recipe directory ([8095c55](https://github.com/introspection-org/pi-recipes/commit/8095c5524e3333be35a4172d206cd345de101bdc))
* submit public recipe publishes to catalog ([09a6f0c](https://github.com/introspection-org/pi-recipes/commit/09a6f0cd6461da629dc776c9b877d06fc2470ad0))


### Bug Fixes

* allow blank agent system instructions ([#4](https://github.com/introspection-org/pi-recipes/issues/4)) ([dc50037](https://github.com/introspection-org/pi-recipes/commit/dc50037c509601748cbc8404c6c472f9eb5f507b))
* drop themes from publish catalog resource counts ([6f12cfa](https://github.com/introspection-org/pi-recipes/commit/6f12cfa6b507dd29a6f50bcaf9587732fb7f2d08))


### Miscellaneous Chores

* force next beta release ([1a3be58](https://github.com/introspection-org/pi-recipes/commit/1a3be58fce15b43d23508a1b61cbc6e4ba1df754))

## 0.1.0-beta.0 (2026-06-25)


### Features

* prepare pi recipes beta release ([4eed1cd](https://github.com/introspection-org/pi-recipes/commit/4eed1cdfd9c32c816306ce041c457701b81c76e3))
