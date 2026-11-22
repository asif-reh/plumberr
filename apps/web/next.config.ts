import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@plumberr/shared"],
  poweredByHeader: false,
};

export default nextConfig;
