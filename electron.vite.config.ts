import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // EVAL-05:评测 CLI 第二入口 → out/main/eval-cli.js(纯 Node 运行,无 Electron 依赖)
          'eval-cli': resolve('src/main/eval-cli.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          workbench: resolve(__dirname, 'src/renderer/workbench.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html')
        }
      }
    }
  }
})
