/** @type {import("next").NextConfig} */
const nextConfig = {
  // word-list locates its dictionary relative to its own module file, so it must
  // be loaded from node_modules at runtime rather than bundled.
  serverExternalPackages: ["word-list"],
  poweredByHeader: false,
  // Don't generate AGENTS.md / CLAUDE.md in the project root during `next dev`.
  agentRules: false,
};
export default nextConfig;
