import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @bide/shared ships TypeScript source (no build step), so Next must compile it.
  transpilePackages: ["@bide/shared"],
  // @bide/shared uses NodeNext-style "./x.js" specifiers for .ts files (the worker needs them).
  // Turbopack can't map .js → .ts, so the app builds with webpack (`--webpack` in package.json).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
