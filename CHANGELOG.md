# Changelog

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
