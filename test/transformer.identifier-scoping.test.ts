import typescript from 'typescript';
import createTransformer from '@src/transformer';
import { transform, transformWithProgram } from './helpers';

describe('transformer — identifier scoping', () => {
  describe('global identifier whitelist', () => {
    it('injects @pre using Math.abs without warning', () => {
      const source = `
        /**
         * @pre Math.abs(delta) < 1
         */
        export function nudge(delta: number): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(Math.abs(delta) < 1)');
    });

    it('injects @pre using isNaN without warning', () => {
      const source = `
        /**
         * @pre isNaN(value) === false
         */
        export function parse(value: number): number { return value; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(isNaN(value) === false)');
    });

    it('injects @pre using JSON.stringify without warning', () => {
      const source = `
        /**
         * @pre JSON.stringify(obj) !== ""
         */
        export function serialize(obj: object): string { return ""; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(JSON.stringify(obj) !== "")');
    });
  });

  describe('destructured parameter binding names', () => {
    it('injects @pre referencing destructured object binding', () => {
      const source = `
        /**
         * @pre x > 0
         */
        export function move({ x, y }: { x: number; y: number }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(x > 0)');
    });

    it('injects @pre referencing nested destructured binding', () => {
      const source = `
        /**
         * @pre bbb > 0
         */
        export function foo({ aaa: { bbb } }: { aaa: { bbb: number } }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(bbb > 0)');
    });

    it('injects @pre referencing array destructured binding', () => {
      const source = `
        /**
         * @pre first > 0
         */
        export function head([first]: number[]): number { return first; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(first > 0)');
    });

    it('injects @pre using alias name, not original property name', () => {
      const source = `
        /**
         * @pre alias > 0
         */
        export function bar({ original: alias }: { original: number }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(alias > 0)');
    });

    it('drops @pre using original property name when aliased', () => {
      const source = `
        /**
         * @pre original > 0
         */
        export function bar({ original: alias }: { original: number }): void {}
      `;
      const warnings: string[] = [];
      transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('original'))).toBe(true);
    });
  });

  describe('TemplateExpression in contract expressions', () => {
    it('injects @pre with an interpolated template literal', () => {
      const source = `
        /**
         * @pre label === \`item_\${id}\`
         */
        export function tag(label: string, id: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(label === `item_${id}`)');
    });

    it('does not drop other contracts when one uses an interpolated template literal', () => {
      const source = `
        /**
         * @pre count > 0
         * @pre label === \`item_\${id}\`
         */
        export function run(count: number, label: string, id: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(count > 0)');
      expect(output).toContain('!(label === `item_${id}`)');
    });
  });

  describe('NoSubstitutionTemplateLiteral in contract expressions', () => {
    it('injects @pre with a no-substitution template literal', () => {
      const source = `
        /**
         * @pre label === \`hello\`
         */
        export function tag(label: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(label === `hello`)');
    });

    it('does not drop other contracts on a function with a no-substitution template literal', () => {
      const source = `
        /**
         * @pre count > 0
         * @pre label === \`ok\`
         */
        export function run(count: number, label: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(count > 0)');
      expect(output).toContain('!(label === `ok`)');
    });
  });

  describe('scope identifiers (enum and module constants)', () => {
    it('injects @pre referencing a const enum member without warning (checker mode)', () => {
      const source = `
        const enum Status { Active = 0, Inactive = 1 }
        /**
         * @pre status === Status.Active
         */
        export function handle(status: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(status === Status.Active)');
    });

    it('injects @pre referencing a module-level const without warning (checker mode)', () => {
      const source = `
        const MAX_SIZE = 100;
        /**
         * @pre amount <= MAX_SIZE
         */
        export function process(amount: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(amount <= MAX_SIZE)');
    });
  });

  describe('allowIdentifiers transformer option', () => {
    it('accepts Status as known identifier when listed in allowIdentifiers', () => {
      const source = `
        /**
         * @pre status === Status.Active
         */
        export function handle(status: number): void {}
      `;
      const warnings: string[] = [];
      const result = typescript.transpileModule(source, {
        compilerOptions: {
          target: typescript.ScriptTarget.ES2020,
          module: typescript.ModuleKind.CommonJS,
        },
        transformers: {
          before: [createTransformer(undefined, {
            warn: (msg) => warnings.push(msg),
            allowIdentifiers: ['Status'],
          })],
        },
      });
      expect(warnings).toHaveLength(0);
      expect(result.outputText).toContain('!(status === Status.Active)');
    });
  });

  describe('exported module constant runtime scoping', () => {
    it('injects @pre referencing exported const with exports. prefix (checker mode)', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre x < MAX_LIMIT
         */
        export function moduleConstantPre(x: number): number {
            return x;
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('exports.MAX_LIMIT');
      expect(output).toContain('!(x < exports.MAX_LIMIT)');
    });

    it('injects @pre referencing exported enum with exports. prefix (checker mode)', () => {
      const source = `
        export enum Mode { Fast = 0, Slow = 1 }
        /**
         * @pre mode === Mode.Fast
         */
        export function checkMode(mode: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('exports.Mode');
      expect(output).toContain('!(mode === exports.Mode.Fast)');
    });
  });
});
