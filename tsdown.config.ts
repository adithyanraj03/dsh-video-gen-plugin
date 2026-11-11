/** Standalone host and browser bundle outputs. */
import type { UserConfig } from 'tsdown'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

const host: UserConfig = {
  name: 'dsh-video-gen',
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const client: UserConfig = {
  name: 'dsh-video-gen/client',
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
  // The host webview has no `process` global; CJS deps read NODE_ENV at
  // runtime, so bake it in at build time.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The loader looks the factory up by the package name; any other id fails to mount.
    banner: 'window.__ModuleLoader__.load({ id: "dsh-video-gen-plugin", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
