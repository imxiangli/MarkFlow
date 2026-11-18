import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // chokidar v5 is ESM-only; bundle it into the CJS main output.
      externalizeDeps: { exclude: ['chokidar'] },
      rolldownOptions: {
        input: {
          // Entry point of the packaged app: picks bundled or hot-updated code.
          bootstrap: resolve('src/bootstrap/index.ts'),
          index: resolve('src/main/index.ts')
        },
        output: {
          // CommonJS dependencies (iconv-lite) need rolldown's runtime helpers, which every entry
          // imports. Without a separate vendor chunk they land in index.js and bootstrap.js would
          // `require("./index.js")` (starting the app) before choosing which copy of it to run.
          codeSplitting: {
            groups: [{ name: 'vendor', test: /node_modules[\\/]/ }]
          },
          // Stable names keep incremental updates small.
          chunkFileNames: 'chunks/[name].js'
        }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    oxc: { jsx: { runtime: 'automatic' } },
    build: {
      chunkSizeWarningLimit: 10000,
      minify: true,
      rolldownOptions: {
        output: {
          // No content hashes: files load from local disk, and stable names keep incremental
          // updates small (a changed chunk no longer renames every chunk that imports it).
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
          // Third-party code changes rarely; keeping it out of the app chunk means a typical
          // release only ships the small app chunk. Only statically imported libraries are
          // listed so lazily loaded ones (mermaid, echarts, extra languages) stay lazy.
          codeSplitting: {
            groups: [
              { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|zustand)[\\/]/ },
              {
                name: 'vendor-editor',
                test: /node_modules[\\/](@codemirror[\\/](state|view|commands|language|language-data|search|autocomplete|lint|lang-markdown|lang-html|lang-css|lang-javascript)|@lezer[\\/](common|highlight|lr|markdown|html|css|javascript)|style-mod|w3c-keyname|crelt|@marijn)[\\/]/
              },
              {
                name: 'vendor-markdown',
                test: /node_modules[\\/](markdown-it[^\\/]*|@vscode[\\/]markdown-it-katex|katex|highlight\.js|dompurify|morphdom|js-yaml|entities|linkify-it|mdurl|uc\.micro|punycode\.js)[\\/]/
              },
              { name: 'vendor-icons', test: /node_modules[\\/]lucide-react[\\/]/ }
            ]
          }
        }
      }
    }
  }
})
