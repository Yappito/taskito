import { defineConfig } from "vitest/config";
import path from "path";
import esbuild from "esbuild";

// Vite 8 transforms with oxc and honours the app tsconfig's "jsx": "preserve",
// which leaves JSX untransformed when tests run in plain node. Pre-transform
// TSX/JSX with esbuild's automatic runtime so component tests can import .tsx
// primitives without a DOM or extra plugins.
const jsxForNode = {
  name: "vitest-jsx-automatic",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/\.[jt]sx$/.test(id.split("?")[0] ?? id)) return null;
    const result = esbuild.transformSync(code, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      target: "es2022",
      sourcemap: false,
    });
    return { code: result.code, map: null };
  },
};

export default defineConfig({
  plugins: [jsxForNode],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
