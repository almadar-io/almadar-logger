import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/timing.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
