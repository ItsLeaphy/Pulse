import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: '/Pulse/', // GitHub Pages de projeto serve em usuario.github.io/Pulse/, não na raiz
  build: {
    outDir: 'dist',
    target: 'es2022'
  }
})
