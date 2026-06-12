import esbuild from 'esbuild';
import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const pkg = require(path.join(rootDir, 'package.json'));

const isWatch = process.argv.includes('--watch');
const isRelease = process.env.RELEASE === '1';
const isFirefox = process.argv.includes('--firefox') || process.env.TARGET === 'firefox';
const isAmo = isFirefox && (process.argv.includes('--amo') || process.env.TARGET === 'amo');

const common = {
  bundle: true,
  sourcemap: isRelease ? false : false, // set true locally if debugging
  minify: isRelease,
  target: isFirefox ? 'firefox127' : 'chrome114',
  platform: 'browser',
  legalComments: 'none',
  format: 'iife', // preserve side-effects and simple global init without ESM runtime
  define: { 'process.env.NODE_ENV': '"production"' },
};

async function copyStaticFiles() {
  const outDir = path.resolve(rootDir, 'dist');

  try {
    // Ensure the output directory exists and is clean
    await fs.emptyDir(outDir);

    // Inject version from package.json into manifest
    const manifest = await fs.readJson(path.join(rootDir, 'manifest.json'));
    manifest.version = pkg.version;

    // Firefox-specific manifest adaptations
    if (isFirefox) {
      delete manifest.minimum_chrome_version;

      if (!manifest.browser_specific_settings?.gecko?.id) {
        manifest.browser_specific_settings = {
          gecko: {
            id: 'videospeed@igrigorik.github.com',
            strict_min_version: '127.0',
          },
        };
      }

      // Firefox needs host_permissions for content scripts
      manifest.host_permissions = ['http://*/*', 'https://*/*'];

      if (isAmo) {
        // ---- AMO release mode ----
        // Firefox requires both background.scripts (primary) and
        // background.service_worker (Chrome compat fallback).
        if (manifest.background?.service_worker) {
          const sw = manifest.background.service_worker;
          manifest.background.scripts = [sw];
          manifest.background.service_worker = sw;
        }

        // data_collection_permissions required by AMO since 2025.
        // The extension doesn't collect or transmit user data, so declare "none".
        manifest.browser_specific_settings.gecko.data_collection_permissions = {
          required: ["none"],
        };

        // Keep original content scripts (ISOLATED + MAIN worlds).
        // All workarounds below are only needed for WebDriver BiDi.
      } else {
        // ---- BiDi / development mode ----
        // Workarounds for Firefox WebDriver BiDi limitations:
        //   - no world:"MAIN" support for temporary installs
        //   - no background.service_worker for temporary installs
        if (manifest.background?.service_worker) {
          manifest.background.scripts = [manifest.background.service_worker];
          delete manifest.background.service_worker;
        }

        // Single content script (bridge), inject.js loaded dynamically
        manifest.content_scripts = [
          {
            matches: ['http://*/*', 'https://*/*', 'file:///*'],
            all_frames: true,
            match_about_blank: true,
            exclude_matches: ['https://hangouts.google.com/*', 'https://meet.google.com/*'],
            js: ['content-bridge.js'],
            run_at: 'document_end',
          },
        ];

        // web_accessible_resources for dynamically injected inject.js
        manifest.web_accessible_resources = [
          {
            matches: ['http://*/*', 'https://*/*', 'file:///*'],
            resources: ['inject.js'],
          },
        ];
      }
    }

    await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });
    console.log(`✅ Manifest version set to ${pkg.version}${isRelease ? ' (release)' : ''}`);

    // Paths to copy
    const pathsToCopy = {
      'src/assets': path.join(outDir, 'assets'),
      'src/ui': path.join(outDir, 'ui'),
      'src/styles': path.join(outDir, 'styles'),
      'LICENSE': path.join(outDir, 'LICENSE'),
      'CONTRIBUTING.md': path.join(outDir, 'CONTRIBUTING.md'),
      'PRIVACY.md': path.join(outDir, 'PRIVACY.md'),
      'README.md': path.join(outDir, 'README.md')
    };

    // Perform copy operations
    for (const [src, dest] of Object.entries(pathsToCopy)) {
      await fs.copy(path.join(rootDir, src), dest, {
        filter: (src) => !path.basename(src).endsWith('.js')
      });
    }

    console.log('✅ Static files copied');
  } catch (error) {
    console.error('❌ Error copying static files:', error);
    process.exit(1);
  }
}

async function build() {
  try {
    await copyStaticFiles();

    const esbuildConfig = {
      ...common,
      entryPoints: {
        'content-bridge': isFirefox && !isAmo ? 'src/entries/content-bridge-firefox.js' : 'src/entries/content-bridge.js',
        'inject': 'src/entries/inject-entry.js',
        'background': 'src/background.js',
        'ui/popup/popup': 'src/ui/popup/popup.js',
        'ui/options/options': 'src/ui/options/options.js'
      },
      outdir: 'dist',
    };

    if (isWatch) {
      const ctx = await esbuild.context(esbuildConfig);
      await ctx.watch();
      console.log('🔧 Watching for changes...');
    } else {
      await esbuild.build(esbuildConfig);
      console.log('✅ Build complete');
    }
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
