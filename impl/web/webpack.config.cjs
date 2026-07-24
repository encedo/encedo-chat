const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')

// Browser build of the web GUI. Mirrors the proven v5 config: no node polyfills
// (the engine is WebCrypto), top-level await, no minify for debuggability.
module.exports = {
  context: path.resolve(__dirname),
  entry: './src/app.ts',
  output: { filename: 'bundle.js', path: path.resolve(__dirname, 'dist'), clean: true },
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
        use: { loader: 'babel-loader', options: { presets: ['@babel/preset-typescript'], plugins: ['@babel/plugin-transform-block-scoping'], compact: false } },
        resolve: { fullySpecified: false },
      },
      {
        test: /\.(js|mjs)$/,
        use: { loader: 'babel-loader', options: { plugins: ['@babel/plugin-transform-block-scoping'], compact: false } },
        resolve: { fullySpecified: false },
      },
    ],
  },
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => { r.request = r.request.replace(/^node:/, '') }),
    new HtmlWebpackPlugin({ template: './index.html' }),
  ],
  optimization: { concatenateModules: false, usedExports: false, minimize: false },
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
