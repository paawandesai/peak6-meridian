/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @meridian/client ships TypeScript source (no build step).
  transpilePackages: ["@meridian/client"],
  webpack: (config, { isServer }) => {
    // Externalize @coral-xyz/anchor in client bundles to avoid build errors
    // (P1-6: anchor imports from @meridian/client only used server-side)
    if (!isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "@coral-xyz/anchor": "commonjs @coral-xyz/anchor",
      });
    }
    return config;
  },
};

export default nextConfig;
