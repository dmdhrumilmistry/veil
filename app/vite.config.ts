import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Strict Content-Security-Policy, injected only into production builds (Vite's dev
 * server needs inline HMR glue). GitHub Pages cannot send headers, so it is a <meta>.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", // user-chosen mailbox relays
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types veil-sw",
].join('; ');

function csp(): Plugin {
  return {
    name: 'veil-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

/** Emits sw.js with a precache list of every file in the build, versioned by content. */
function serviceWorker(): Plugin {
  return {
    name: 'veil-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = ['./', './index.html', ...Object.keys(bundle).map((f) => `./${f}`)];
      const extra = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].map((f) => `./${f}`);
      const precache = [...new Set([...files, ...extra])].filter((f) => !f.endsWith('.map'));
      const version = `${pkg.version}-${Object.keys(bundle).sort().join('').length.toString(36)}-${Date.now().toString(36)}`;
      const src = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [csp(), serviceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
  },
});
