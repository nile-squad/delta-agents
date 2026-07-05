/* single source of truth for site identity and the GitHub repo location;
   every GitHub link in the site derives from here */
export const appName = "Delta Agents";

export const gitConfig = {
  user: "nile-squad",
  repo: "delta-agents",
  branch: "main",
};

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
