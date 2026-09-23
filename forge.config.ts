import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const webpackDevPort = Number(process.env.WEBPACK_DEV_PORT || 3045);
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: local-file:",
  "connect-src 'self' http://localhost:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');
const exiftoolVendorPackage = process.platform === 'win32'
  ? 'exiftool-vendored.exe'
  : 'exiftool-vendored.pl';

const config: ForgeConfig = {
  packagerConfig: {
    icon: path.join('.', 'assets', 'icons', 'image-puma'),
    extraResource: [
      path.join('.', 'node_modules', exiftoolVendorPackage),
      path.join('.', 'build', 'background-removal-runtime'),
      path.join('.', 'build', 'heif-decoder'),
      path.join('.', 'src', 'main', 'background-removal', 'RMBG-2.0-NOTICE.txt'),
    ],
    asar: {
      unpack: '**/native_modules/sharp*/**/*',
      // Sharp's Windows DLLs must sit beside the .node file. A glob does not
      // unpack them on Windows, so unpack the whole platform directory.
      unpackDir: process.platform === 'win32'
        ? path.join('.webpack', 'main', 'native_modules', 'sharp-win32-x64')
        : '.webpack/main/native_modules/sharp-libvips-darwin-arm64',
    },
  },
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') return;

      for (const outputPath of packageResult.outputPaths) {
        const appPaths = outputPath.endsWith('.app')
          ? [outputPath]
          : fs.readdirSync(outputPath)
            .filter((entry) => entry.endsWith('.app'))
            .map((entry) => path.join(outputPath, entry));

        for (const appPath of appPaths) {
          execFileSync(
            '/usr/bin/codesign',
            ['--force', '--deep', '--sign', '-', appPath],
            { stdio: 'inherit' },
          );
        }
      }
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      setupExe: 'Image-Puma-Setup.exe',
      setupIcon: path.join('.', 'assets', 'icons', 'image-puma.ico'),
    }),
    new MakerDMG({
      name: 'Image-Puma',
    }, ['darwin']),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      port: webpackDevPort,
      devContentSecurityPolicy: contentSecurityPolicy,
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
