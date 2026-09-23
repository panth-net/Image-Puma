import type { Configuration } from 'webpack';
import webpack from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

const mainPlugins = [...plugins];

// src/index.ts anchors the Apple Silicon libvips dylib with a static require.
// That package is an optional dependency and is not installed on Windows, so
// webpack must ignore it unless this build is actually for darwin arm64.
if (!(process.platform === 'darwin' && process.arch === 'arm64')) {
  mainPlugins.push(new webpack.IgnorePlugin({
    resourceRegExp: /^@img\/sharp-libvips-darwin-arm64\/lib$/,
  }));
}

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/index.ts',
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins: mainPlugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
