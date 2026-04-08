import { createRequire } from "module";
const require = createRequire(import.meta.url);

import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";

// Importing the individual rule sets from airbnb-base
// This bypasses the ESM loader issues in Node 25
const airbnbBestPractices = require("eslint-config-airbnb-base/rules/best-practices");
const airbnbErrors = require("eslint-config-airbnb-base/rules/errors");
const airbnbNode = require("eslint-config-airbnb-base/rules/node");
const airbnbStyle = require("eslint-config-airbnb-base/rules/style");
const airbnbVariables = require("eslint-config-airbnb-base/rules/variables");
const airbnbEs6 = require("eslint-config-airbnb-base/rules/es6");

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.mjs", "jest.config.ts"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Spread each individual rule set
      ...airbnbBestPractices.rules,
      ...airbnbErrors.rules,
      ...airbnbNode.rules,
      ...airbnbStyle.rules,
      ...airbnbVariables.rules,
      ...airbnbEs6.rules,

      // TypeScript Recommended Rules
      ...tseslint.configs["recommended"].rules,
      // Use optional chaining in case the specific version naming differs
      ...(tseslint.configs["recommended-type-checked"]?.rules || {}),


      // Your Specific Overrides
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",

      // Essential Airbnb-to-TS compatibility overrides
      "import/extensions": "off",
      "import/no-unresolved": "off",
      "import/prefer-default-export": "off",
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",

      // Tuned Airbnb rules
      "no-param-reassign": ["error", { "props": false }], // ban param rebinding, allow property mutation

      // Disabled Airbnb rules
      "no-underscore-dangle": "off",  // TS has private keyword; _name convention is fine
      "no-restricted-syntax": "off",  // for...of is fine in modern TS/Node — regenerator concern is obsolete
      "no-plusplus": "off",           // i++ in loops is universally understood
      "no-redeclare": "off",          // TS function overloads look like redeclarations; TS compiler handles this
    },
  },
  {
    files: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        jest: "readonly",
      },
    },
  },
  prettierConfig,
  {
    files: ["src/**/*.ts"],
    plugins: {
      unicorn,
    },
    rules: {
      "unicorn/no-for-loop": "error",
      "unicorn/prefer-array-some": "error",
      "unicorn/prefer-array-find": "error",
      "unicorn/prefer-set-has": "error"
    }
  },
  {
    files: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "complexity": ["error", 10],
        "max-len": ["error", { "code": 100 }],
        "@typescript-eslint/no-confusing-void-expression": ["error", {
          "ignoreArrowShorthand": true
        }],
        "curly": ["error", "all"],
        "brace-style": ["error", "1tbs", { "allowSingleLine": false }],
        // Parser files: stricter naming — no single-letter or two-letter identifiers
        "id-length": ["error", { "min": 3, "exceptions": ["id", "to", "ok", "fs"] }],
        "no-useless-return": "error",
        "no-restricted-syntax": [
          "error",
          // 1. Catch the "Set crud" (Manual guard loops)
          {
            "selector": "ForOfStatement > BlockStatement > IfStatement[test.operator='!'] > ReturnStatement[argument.value=false]",
            "message": "This manual guard loop can be replaced with .every() or .isSubsetOf()."
          },
          // 2. Catch the "Naked Returns"
          {
            "selector": "ReturnStatement[argument=null]",
            "message": "Early returns (naked returns) are disallowed. Ensure the function logic flows to the end."
          },
          {
            "selector": "BinaryExpression[operator='==='] > Literal[value=/./]",
            "message": "Don't compare against raw strings. Use a constant or Type."
          },
          {
            "selector": "BinaryExpression[operator='!=='] > Literal[value=/./]",
            "message": "Don't compare against raw strings. Use a constant or Type."
          }
        ]
      }
  }

];