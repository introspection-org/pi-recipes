# Changelog

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
