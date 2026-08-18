import type { NextConfig } from "next";

const isGithubActions = process.env.GITHUB_ACTIONS || false;

let basePath = '';

if (isGithubActions) {
  // If the repository is not a root username.github.io site, set the basePath
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (repo && !process.env.GITHUB_REPOSITORY?.match(/.*\.github\.io$/)) {
    basePath = `/${repo}`;
  }
}

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: {
    unoptimized: true,
  },
  /* config options here */
};

export default nextConfig;
