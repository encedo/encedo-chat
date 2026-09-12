const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const crypto = require('crypto')
const { execSync } = require('child_process')

// Which build is this? Stamped in so a screenshot or a bug report identifies the
// code that produced it — the version alone cannot, because several builds carry
// one version. A tree with no git (a tarball, a container without .git) still
// builds; it just says `nogit` instead of a hash.
const VERSION = require('../package.json').version
const COMMIT = (() => {
  try {
    const h = execSync('git rev-parse --short=8 HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    // A dirty tree is not the commit it claims to be, and saying so costs one character.
    const dirty = execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return h + (dirty ? '+' : '')
  } catch { return 'nogit' }
})()

// Browser build of the web GUI. No node polyfills (engine is WebCrypto),
// top-level await. Minified in production, readable in development.
module.exports = (_env, argv) => {
  const prod = argv.mode === 'production'
  // `?keys=1` prints the protocol's secret material (lib/protolog.ts). That is a
  // development capability and it must be possible to build WITHOUT it — not
  // merely to leave the flag untyped — so the switch is compile-time: with
  // EC_ALLOW_KEYS=0 the branch is `false && …` and the minifier removes it, and
  // no URL can bring it back. Default ON while this is R&D; the MVP deploy sets
  // it to 0.
  const allowKeys = process.env.EC_ALLOW_KEYS !== '0'
  if (prod && !allowKeys) console.log('[build] ?keys=1 disabled — no key material can be printed by this bundle')
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
      // The favicon, into a directory the build empties on every run.
      //
      // `output.clean` wipes dist/, and dist/ IS the web root — so a favicon
      // copied there by hand lives until the next deploy and then 404s, quietly,
      // for as long as it takes somebody to notice a missing tab icon. Copying
      // it here makes it part of the build rather than part of somebody's
      // memory. A hand-written plugin rather than copy-webpack-plugin: this is
      // one file, and the dependency would be the larger thing.
      {
        apply(compiler) {
          compiler.hooks.afterEmit.tap('copy-favicon', () => {
            const fs = require('fs')
            fs.copyFileSync(
              path.resolve(__dirname, 'favicon.ico'),
              path.resolve(compiler.options.output.path, 'favicon.ico'),
            )
            // The rest of the icon set travels the same way, for the same
            // reason. `icons/` is generated (scripts/build-icons.mjs) and is
            // small enough that copying it whole beats listing names that will
            // change the next time somebody adds a size.
            fs.cpSync(
              path.resolve(__dirname, 'icons'),
              path.resolve(compiler.options.output.path, 'icons'),
              { recursive: true },
            )
          })
        },
      },
      new webpack.DefinePlugin({
        __EC_ALLOW_KEYS__: JSON.stringify(allowKeys),
        __EC_VERSION__: JSON.stringify(VERSION),
        __EC_COMMIT__: JSON.stringify(COMMIT),
      }),
      new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => { r.request = r.request.replace(/^node:/, '') }),
      new HtmlWebpackPlugin({ template: './index.html', filename: 'index.html', chunks: ['app'] }),
      // The CSP in index.html names the inline script by HASH, and the hash has
      // to be of what is EMITTED: html-webpack-plugin minifies the page, so a
      // hash taken from the source file is wrong by a few characters and the
      // browser silently refuses the script — the theme then applies from the
      // bundle instead, one frame late, which looks like a flash rather than
      // like a policy error. So it is computed here, after the page is final.
      //
      // Deliberately not a dependency: twenty lines against a package, on a
      // step that has to stay understandable — the whole point of the policy is
      // that somebody can read what it allows.
      {
        apply(compiler) {
          // Subresource Integrity, liczone na SAMYM KOŃCU potoku.
          //
          // Bez SRI `index.html` zobowiązuje się tylko do NAZWY pliku: hash w
          // nazwie jest webpacka i nikt go nie sprawdza, więc serwer może pod tą
          // samą nazwą oddać co innego. Z SRI przeglądarka sama odmawia
          // wykonania niezgodnego skryptu — a wtedy opublikowanie CID-a samego
          // `index.html` domyka cały łańcuch: jeden mały plik ręczy
          // kryptograficznie za 1,4 MB reszty.
          //
          // Etap REPORT, a nie hak html-webpack-plugin: w trybie produkcyjnym
          // zawartość assetów jest finalizowana PÓŹNIEJ (minifikacja, wyciąganie
          // licencji, `realContentHash`), więc hash policzony wcześniej nie
          // zgadza się z plikiem, który wyjdzie na dysk. Sprawdzone — pierwsza
          // wersja tego kodu wpisywała do HTML-a hash nieistniejącej treści.
          compiler.hooks.compilation.tap('Sri', (compilation) => {
            const { Compilation, sources } = compiler.webpack
            compilation.hooks.processAssets.tap(
              { name: 'Sri', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
              (assets) => {
                for (const name of Object.keys(assets)) {
                  if (!name.endsWith('.html')) continue
                  const before = assets[name].source().toString()
                  const after = before.replace(/<script([^>]*?)src="([^"]+\.bundle\.js)"([^>]*)>/g,
                    (tag, pre, src, post) => {
                      const asset = assets[src]
                      if (!asset) throw new Error(`SRI: brak assetu ${src}`)
                      const sri = crypto.createHash('sha384').update(asset.source()).digest('base64')
                      return `<script${pre}src="${src}"${post} integrity="sha384-${sri}">`
                    })
                  if (after !== before) compilation.updateAsset(name, new sources.RawSource(after))
                }
              })
          })
          compiler.hooks.compilation.tap('CspHashes', (compilation) => {
            HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tapAsync('CspHashes', (data, cb) => {
              const hashes = []
              data.html = data.html.replace(/<script>([\s\S]*?)<\/script>/g, (m, body) => {
                hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`)
                return m
              })
              if (data.html.includes('__CSP_SCRIPT_HASHES__')) {
                data.html = data.html.replace('__CSP_SCRIPT_HASHES__', hashes.join(' '))
              } else if (hashes.length && data.outputName === 'index.html') {
                // The placeholder is how the policy learns about inline scripts.
                // Losing it means shipping a page whose own script is refused.
                cb(new Error('index.html has inline scripts but no __CSP_SCRIPT_HASHES__ in its CSP'))
                return
              }
              cb(null, data)
            })
          })
        },
      },
      new HtmlWebpackPlugin({ template: './webrtc-test.html', filename: 'webrtc-test.html', chunks: ['webrtc-test'] }),
      // The public landing page, carried through verbatim: no chunks, no
      // injection, no minifier. It has no bundle — the whole point is that a
      // first-time visitor downloads a few KB of HTML rather than 1.2 MiB of
      // libp2p — and `index.html` deliberately stays the APP, so the desktop
      // and Android builds, which load dist/index.html, are untouched by this.
      // Which page is served at `/` is a decision for the WEB deploy alone; see
      // infra/README.md for the nginx mapping.
      new HtmlWebpackPlugin({ template: './landing.html', filename: 'landing.html', chunks: [], inject: false, minify: false }),
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
