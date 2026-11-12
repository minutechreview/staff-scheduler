import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.js'

export default mergeConfig(base, defineConfig({
  build: { outDir: 'dist-email-preview', rolldownOptions: { input: 'preview.html' } },
}))
