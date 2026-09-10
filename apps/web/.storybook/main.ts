import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

/** The engine's lazy import of emscripten's glue, resolved by the wasm build only. */
const WASM_GLUE = "/wasm/punktfunk-client-web.js";

// The app's own `vite.config.ts` is picked up as-is: it is already the slim shape Storybook
// wants (React, Tailwind, the two aliases) and nothing in it names a server or a host.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: (base) =>
    mergeConfig(base, {
      plugins: [
        {
          // No story creates an `Engine`, so the glue need not exist: the stories build and run
          // without the emscripten toolchain, on a checkout that has never built the wasm.
          name: "pf-no-wasm",
          resolveId: (id: string) => (id.endsWith(WASM_GLUE) ? "\0pf-no-wasm" : null),
          load: (id: string) =>
            id === "\0pf-no-wasm"
              ? "export default () => { throw new Error('Storybook has no engine'); };"
              : null,
        },
      ],
    }),
};

export default config;
