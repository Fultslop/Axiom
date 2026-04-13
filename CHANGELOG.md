# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.9.0-alpha.3] - 2026-04-13

### Fixed
- Optional chaining false-positive — `@pre obj?.value > 0` on a nullable parameter (`T | null`) no longer emits a spurious "property does not exist" warning; nullability is stripped before each step of the property chain walk
- Misuse detection — `@pre`/`@post` on constructors, arrow functions, function expressions, non-exported/nested function declarations, and class declarations now emit targeted `[axiom] Warning:` diagnostics; `@invariant` on non-class nodes is similarly reported

## [0.9.0-alpha.1] - 2026-04-13

### Added
- `@pre`, `@post`, `@invariant`, `@prev` JSDoc contract tags enforced at runtime in dev builds
- Interface contract inheritance — contracts on interfaces propagate to all implementing classes
- Class invariants via `@invariant` — checked after constructor and every public method exit
- `@prev` three-tier syntax: auto shallow clone, `@prev deep`, or custom expression
- `ContractError` base class with `ContractViolationError` and `InvariantViolationError` subtypes
- Manual assertion functions `pre()` and `post()` for cases the transformer cannot reach
- `snapshot()` and `deepSnapshot()` runtime utilities
- Template literal support in contract expressions
- Enum and module-level constant resolution via TypeChecker scope analysis
- Parameter name mismatch handling between interface and class signatures
- Additive merge when both interface and class define contracts for the same method
- Destructured parameter binding recognition
- Union-typed parameter support (`T | null`, `T | undefined`)
- Zero contract overhead in release builds — plain `tsc` strips all contract code
