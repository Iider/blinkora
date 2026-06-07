import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from 'path';
import tailwindcss from '@tailwindcss/vite'

const DEV_FRONTEND_PORT = Number(process.env.BLINKORA_DEV_FRONTEND_PORT || 5173);
const DEV_BACKEND_TARGET = process.env.BLINKORA_DEV_BACKEND_URL || 'http://127.0.0.1:6677';

const packageNameFromNodeModule = (id: string) => {
  const parts = id.split('node_modules/')[1]?.split('/');
  if (!parts?.length) return '';
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};

const packageIn = (pkg: string, names: string[]) =>
  names.some((name) => pkg === name || pkg.startsWith(`${name}/`));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          const pkg = packageNameFromNodeModule(id);
          if (!pkg) return undefined;

          if (packageIn(pkg, ['react', 'react-dom', 'react-router-dom', 'scheduler', 'use-sync-external-store'])) {
            return 'vendor-react';
          }

          if (
            packageIn(pkg, ['@heroui', '@react-aria', '@react-stately', '@react-types', '@internationalized', 'framer-motion', 'motion']) ||
            packageIn(pkg, ['mobx', 'mobx-react-lite', '@trpc', 'superjson', 'zod', 'axios', 'dayjs', 'lodash', 'lodash-es', 'i18next', 'react-i18next', 'i18next-browser-languagedetector', 'i18next-http-backend', 'next-themes', 'clsx', 'tailwind-merge', 'usehooks-ts', 'filesize'])
          ) {
            return 'vendor-foundation';
          }

          if (packageIn(pkg, ['@dnd-kit', 'react-beautiful-dnd-next', 'react-dropzone', 'react-masonry-css', 'react-burger-menu', 'rctx-contextmenu'])) {
            return 'vendor-interactions';
          }

          if (packageIn(pkg, ['react-syntax-highlighter', 'highlight.js', 'lowlight', 'refractor', 'prismjs'])) {
            return 'vendor-syntax';
          }

          if (
            packageIn(pkg, ['vditor', 'react-markdown', 'remark-gfm', 'remark-math', 'remark-task-list', 'rehype-katex', 'rehype-raw', 'katex', 'unified', 'vfile', 'dompurify', 'sanitize-html', 'yaml']) ||
            pkg.startsWith('micromark') ||
            pkg.startsWith('mdast-') ||
            pkg.startsWith('hast-') ||
            pkg.startsWith('unist-') ||
            pkg.startsWith('vfile-') ||
            pkg.startsWith('remark-') ||
            pkg.startsWith('rehype-') ||
            packageIn(pkg, ['property-information', 'space-separated-tokens', 'comma-separated-tokens', 'decode-named-character-reference', 'character-entities', 'ccount', 'bail', 'devlop', 'trough', 'zwitch', 'trim-lines', 'longest-streak', 'markdown-table', 'parse-entities', 'stringify-entities', 'web-namespaces', 'html-void-elements', 'html-url-attributes'])
          ) {
            return 'vendor-editor';
          }

          if (packageIn(pkg, ['echarts'])) {
            return 'vendor-charts';
          }

          if (packageIn(pkg, ['mermaid', '@mermaid-js'])) {
            return 'vendor-mermaid';
          }

          if (packageIn(pkg, ['markmap-common', 'markmap-lib', 'markmap-view'])) {
            return 'vendor-markmap';
          }

          if (
            packageIn(pkg, ['cytoscape', 'cytoscape-cose-bilkent', 'dagre-d3-es', 'd3']) ||
            pkg.startsWith('d3-')
          ) {
            return 'vendor-diagrams';
          }

          if (packageIn(pkg, ['three', '@react-three', '@react-spring', '@shadergradient', 'react-photo-view', 'swiper', 'react-webcam', 'canvas-confetti', 'emoji-picker-react', 'qrcode.react', 'react-file-icon'])) {
            return 'vendor-media';
          }

          if (packageIn(pkg, ['@iconify'])) {
            return 'vendor-icons';
          }

          if (packageIn(pkg, ['react-dev-inspector', 'antd', '@ant-design', 'lucide-react', 'date-fns', '@babel'])) {
            return 'vendor-devtools';
          }

          if (packageIn(pkg, ['core-js', 'web-streams-polyfill', 'fetch-blob', 'formdata-node', 'encoding-sniffer', 'whatwg-encoding', 'node-domexception', 'intersection-observer', 'stable', 'inflight', 'glob', 'rimraf', '@humanwhocodes'])) {
            return 'vendor-compat';
          }

          if (packageIn(pkg, ['react-hot-toast', 'react-accessible-treeview', '@floating-ui', 'aria-hidden', '@motionone', 'popmotion'])) {
            return 'vendor-ui-helpers';
          }

          return undefined;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: DEV_FRONTEND_PORT,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: DEV_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/sse': {
        target: DEV_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/messages': {
        target: DEV_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/trpc': {
        target: DEV_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/vditor-assets': {
        target: DEV_BACKEND_TARGET,
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/node_modules/**", "**/.git/**"],
    },
  },
  optimizeDeps: {
    force: false,
    include: ['react', 'react-dom', 'react-router-dom'],
    exclude: []
  },
  css: {
    devSourcemap: false
  },
  cacheDir: 'node_modules/.vite',
  experimental: {
    renderBuiltUrl: (filename) => ({ relative: true }),
    hmrPartialAccept: true
  }
});
