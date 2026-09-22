import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * There is a lockfile here and another at the repository root, which is
   * correct: the root one locks the devnet test harness and this one locks the
   * application. Turbopack cannot tell which directory is the project root from
   * that alone, so it is said explicitly rather than left to a warning on every
   * build that would eventually hide a real one.
   */
  turbopack: { root: __dirname },
  /* config options here */
};

export default nextConfig;
