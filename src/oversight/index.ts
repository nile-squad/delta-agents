/**
 * Human oversight — approvals and escalation.
 *
 * Public surface:
 *   requestApproval / resolveApproval / getApproval / getApprovalStatusForAction
 *   checkEscalation / raiseEscalation / getEscalations
 */

export { requestApproval, resolveApproval, getApproval, getApprovalStatusForAction } from "./approvals";
export { checkEscalation, raiseEscalation, getEscalations } from "./escalation";
export { applyPostStepGovernance } from "./post-step";
export type { PostStepGovernance } from "./post-step";
export type { EscalationContext, EscalationCheck } from "./types";
