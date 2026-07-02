import { join } from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginLlms } from "@rspress/plugin-llms";

export default defineConfig({
  root: join(__dirname, "docs"),
  base: "/delta-agents/",
  title: "Delta Agents",
  description:
    "Deterministic governance and control-plane engine for AI agents",
  icon: "/rspress-icon.png",
  logoText: "Delta Agents",
  plugins: [pluginLlms()],
  themeConfig: {
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/hussein-kizz/delta-agents",
      },
    ],
    // Built-in search is enabled by default
    search: true,
    llmsUI: true,
  },
  markdown: {
    showLineNumbers: true,
    shiki: {
      theme: "material-theme-ocean",
    },
    link: {
      checkDeadLinks: {
        excludes: ["/llms.txt", "/llms-full.txt"],
      },
    },
  },
});
