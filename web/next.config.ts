import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
