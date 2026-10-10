/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @meridian/client ships TypeScript source (no build step).
  transpilePackages: ["@meridian/client"],
};

export default nextConfig;
