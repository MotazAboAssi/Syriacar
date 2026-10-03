import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Replit proxy hosts can have multiple subdomain levels; allow the exact host.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    ...(process.env.REPLIT_DEV_DOMAIN ? [process.env.REPLIT_DEV_DOMAIN] : []),
  ],
  // Do not let framework startup generate extra repository instruction files.
  agentRules: false,
};

export default nextConfig;