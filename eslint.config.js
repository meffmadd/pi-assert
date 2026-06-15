// ESLint flat config (eslint v9+).  High-signal defaults only — anything
// noisy or stylistic is left to TypeScript itself.

import tseslint from "typescript-eslint";

export default tseslint.config(
  // ── Global ignores ──────────────────────────────────────────────
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".pi/**",
      "coverage/**",
      // The `examples/` directory is documentation-only, not part of
      // the runtime — keep it lintable in case someone copies code
      // out of it, but skip vendor-like subpaths.
    ],
  },

  // ── TypeScript-ESLint recommended rules ─────────────────────────
  // These are non-type-checked so they run fast and don't need a
  // `parserOptions.project` setup.  Add the type-checked recommended
  // config (`tseslint.configs.recommendedTypeChecked`) only if/when
  // we want rules that need full type information.
  ...tseslint.configs.recommended,

  // ── Project-specific tweaks ─────────────────────────────────────
  {
    files: ["**/*.ts"],
    rules: {
      // The "would have caught the bug" rule:
      //   `themeLine(theme: any, …)` was the original sin.
      "@typescript-eslint/no-explicit-any": "error",

      // Catch dead code; underscore-prefixed args are the common
      // "intentionally unused" idiom for `Component` interface impls.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Force === / !== everywhere — there are no `==` or `!=` in the
      // codebase, and we want to keep it that way.
      "eqeqeq": ["error", "smart"],

      // Don't let `let` sneak in where `const` would do.
      "prefer-const": "error",

      // Block `var` (we use `let`/`const` exclusively).
      "no-var": "error",

      // Catch accidentally dangling promises.  Cheap to add; huge
      // value if we ever start awaiting user input or chained calls.
      "no-floating-promises": "off", // requires type-checked config
    },
  },

  // ── Tests get a pass on `as any` and `any`-typed fixtures ───────
  // Tests legitimately pass `null`, `undefined`, and otherwise-typed
  // values to verify edge-case behaviour of the public API.  We don't
  // want lint to fight that.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
