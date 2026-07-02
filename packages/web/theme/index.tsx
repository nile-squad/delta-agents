import { Layout as OriginalLayout } from "@rspress/core/theme-original";
import "./index.css";

// Re-export everything from the original theme
export * from "@rspress/core/theme-original";

/** Root layout wrapper. */
export function Layout() {
  return <OriginalLayout />;
}
