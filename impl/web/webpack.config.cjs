const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')

// Browser build of the web GUI. No node polyfills (engine is WebCrypto),
// top-level await. Minified in production, readable in development.
module.exports = (_env, argv) => {
  const prod = argv.mode === 'production'
  return {
    context: path.resolve(__dirname),
    entry: { app: './src/app.ts', 'webrtc-test': './src/webrtc-test.ts' },
    // content-hash in prod so every deploy busts the browser cache (index.html,
    // served fresh, points at the new name); stable name in dev for clean HMR.
    output: { filename: prod ? '[name].[contenthash].bundle.js' : '[name].bundle.js', path: path.resolve(__dirname, 'dist'), clean: true },
    resolve: {
      extensions: ['.ts', '.js', '.mjs'],
      // The HEM SDK dynamically imports node:https/http/url only in its Node path
      // (the browser uses fetch). Strip the node: scheme, then map to empty.
      fallback: {
        crypto: false, stream: false, buffer: false, path: false, fs: false, os: false,
        https: false, http: false, url: false, net: false, tls: false, zlib: false,
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: { loader: 'babel-loader', options: { presets: ['@babel/preset-typescript'], plugins: ['@babel/plugin-transform-block-scoping'], compact: prod } },
          resolve: { fullySpecified: false },
        },
        {
          test: /\.(js|mjs)$/,
          use: { loader: 'babel-loader', options: { plugins: ['@babel/plugin-transform-block-scoping'], compact: prod } },
          resolve: { fullySpecified: false },
        },
      ],
    },
    plugins: [
      new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => { r.request = r.request.replace(/^node:/, '') }),
      new HtmlWebpackPlugin({ template: './index.html', filename: 'index.html', chunks: ['app'] }),
      new HtmlWebpackPlugin({ template: './webrtc-test.html', filename: 'webrtc-test.html', chunks: ['webrtc-test'] }),
    ],
    // Every build was cold, and the work is not small: the .js/.mjs rule below
    // has no `exclude`, so ~920 node_modules files (libp2p, 3.3 MiB) go through
    // Babel and then Terser each time — ~40 CPU-seconds, which is ~3 minutes on
    // the 2-vCPU deploy host. Caching that costs nothing: same input, same
    // output, just not recomputed.
    //
    // The directory is deliberately NOT the default (`node_modules/.cache`):
    // deploying runs `npm ci`, which DELETES node_modules, so the default cache
    // could never survive to the build that needs it. `buildDependencies` makes
    // a change to this file invalidate everything, so the cache cannot serve a
    // stale config.
    cache: {
      type: 'filesystem',
      cacheDirectory: path.resolve(__dirname, '../.webpack-cache'),
      buildDependencies: { config: [__filename] },
    },
    optimization: { minimize: prod },
    performance: { hints: false },
    experiments: { topLevelAwait: true },
    devServer: {
      port: 3000,
      hot: true,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  }
}
