export type { TaskStateSnapshot, LegalityResult, PrerequisiteResult } from "./types";

export { evaluatePrerequisites } from "./evaluate-prerequisites";
export { checkLegality } from "./check-legality";
export type { DiscoveryResult } from "./discover-actions";
export { discoverActions } from "./discover-actions";
export {
  snapshotFromTask,
  snapshotFromJson,
  snapshotToJson,
  withCompletedAction,
  withCompletedWorkflow,
  withStatus,
  withSpent,
  withEscalation,
} from "./task-state";
