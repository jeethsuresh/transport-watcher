import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /** Map app uses imperative Leaflet + Socket.IO; double mount in dev breaks listeners. */
  reactStrictMode: false,
};

export default nextConfig;
