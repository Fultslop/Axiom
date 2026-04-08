# boilerplate typescript lib

TypeScript library, published to a local npm registry (Verdaccio at `http://localhost:4873`).

## Project structure

```
src/         Source files
test/        Test files
dist/        Compiled output (do not edit)
doc/         Documentation
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run Jest tests |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint auto-fix |
| `npm run format` | Prettier format `src/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run knip` | Find unused exports and dead code |
| `npm publish` | Publish to local Verdaccio registry |

## Publishing to local registry

The local Verdaccio registry must be running at `http://localhost:4873`.

To start Verdaccio (if not running):
```bash
npx verdaccio
```

To log in (first time):
```bash
npm adduser --registry http://localhost:4873
```

To publish:
```bash
npm publish
```

To consume from another local project:
```bash
npm install <your project> --registry http://localhost:4873
```
Or add `.npmrc` to the consuming project:
```
@scope:registry=http://localhost:4873
registry=http://localhost:4873
```

## Conventions

- All source in `src/`, tests co-located as `*.test.ts` or `*.spec.ts`
- `prepublishOnly` runs typecheck + lint + tests + build — do not skip it
- 80% coverage threshold enforced by Jest
