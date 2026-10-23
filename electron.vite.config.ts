import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The low-level keyboard hook must not share a process with the UI:
          // it owns a message pump and swallows keys.
          hotkey: resolve('src/main/hotkey/child.ts'),
          // UI Automation reaches into other apps' accessibility providers. A
          // provider fault must kill this child, never the UI.
          uia: resolve('src/main/uia/child.ts'),
          // The speech recogniser owns ~230 MB of native weights. Out of
          // process, 释放内存 is a kill instead of a wish, and a faulty model
          // cannot take the UI down with it.
          'local-asr': resolve('src/main/local-asr/worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          settings: resolve('src/renderer/settings.html'),
          assistant: resolve('src/renderer/assistant.html'),
          screenshot: resolve('src/renderer/screenshot.html'),
          bar: resolve('src/renderer/bar.html'),
          // Ask Anything answer card: its own frameless window.
          card: resolve('src/renderer/card.html'),
          // Sign-in: its own window, closable, because dictation works signed out.
          login: resolve('src/renderer/login.html'),
          reminder: resolve('src/renderer/reminder.html')
        }
      }
    }
  }
})
