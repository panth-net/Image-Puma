import type { Configuration } from 'webpack';

import { plugins } from './webpack.plugins';

// Renderer only needs TS + CSS + image loaders (no native-module loaders)
const rendererRules = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
      },
    },
  },
  {
    test: /\.css$/,
    use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
  },
  {
    test: /\.(webp|png|jpe?g|gif|svg)$/i,
    type: 'asset/resource',
  },
];

export const rendererConfig: Configuration = {
  devtool: 'source-map',
  module: {
    rules: rendererRules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
