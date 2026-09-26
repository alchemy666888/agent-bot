import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "dist/**"]),
  {
    files: [
      "src/app/dashboard/**/*.{ts,tsx}",
      "src/components/dashboard/**/*.{ts,tsx}",
    ],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/**", "@/worker/**"],
              message:
                "Client-facing app modules must not import secret-bearing internals.",
            },
          ],
        },
      ],
    },
  },
]);
