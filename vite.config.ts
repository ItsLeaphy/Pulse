import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  root: '.',
  base: '/Pulse/', // GitHub Pages de projeto serve em usuario.github.io/Pulse/, não na raiz
  build: {
    outDir: 'dist',
    target: 'es2022'
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Pulse',
        short_name: 'Pulse',
        description: 'O que está acontecendo com as coisas que fazem parte da minha vida.',
        start_url: '/Pulse/',
        scope: '/Pulse/',
        display: 'standalone',
        background_color: '#f5f2eb',
        theme_color: '#111111',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // cache-first pro app funcionar offline depois de instalado
        globPatterns: ['**/*.{js,css,html,png,svg}']
      }
    })
  ]
})