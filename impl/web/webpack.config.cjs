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
