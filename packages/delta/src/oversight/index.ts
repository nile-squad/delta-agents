/**
 * Human oversight — approvals and escalation.
 *
 * Public surface:
 *   requestApproval / recordAutoApproval / resolveApproval / getApproval /
 *   getApprovalStatusForAction / approvalRequired / describeRejection
 *   checkEscalation / raiseEscalation / getEscalations
 */

export { requestApproval, recordAutoApproval, resolveApproval, getApproval, getApprovalStatusForAction, approvalRequired, describeRejection } from "./approvals";
export { checkEscalation, raiseEscalation, getEscalations } from "./escalation";
export { applyPostStepGovernance } from "./post-step";
export type { PostStepGovernance } from "./post-step";
export type { EscalationContext, EscalationCheck } from "./types";
