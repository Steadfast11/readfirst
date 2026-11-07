import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.DESKTOP_BUILD ? "standalone" : undefined,
  devIndicators: false,
  serverExternalPackages: ["pg", "pg-boss", "nodemailer", "imapflow", "mailparser"],
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
