/**
 * delta-agents-example — an order support agent.
 *
 * Scenario: a support agent can look up an order and issue a refund. Looking
 * up an order is cheap and reversible, so it runs freely. Issuing a refund
 * moves real money, so the action is declared `requiresApproval: true` — the
 * model can *propose* the refund, but delta-agents' execution gateway will
 * not run it until a human calls `delta.approve(...)`.
 *
 * This file wires everything end to end with zero external dependencies:
 *   1. Create the engine with `createMockReasoner`, scripted to request the
 *      same two actions a real model would pick for this goal.
 *   2. Deploy the support agent (see src/agents/support-agent.ts).
 *   3. `delta.send(...)` — runs until it blocks on the refund's approval gate.
 *   4. `delta.inspect(...)` to find the pending approval, `delta.approve(...)`
 *      it, then `delta.resume(...)` to let the agent finish.
 *   5. `delta.inspect(...)` again to print the full governance/audit trail.
 *
 * Run with `pnpm dev` (Bun) or `pnpm build && pnpm start` (Node).
 */

import { createDeltaEngine, createMockReasoner } from "delta-agents";
import { createSupportAgent, ACTION_NAMES, AGENT_NAME } from "./agents/support-agent";

const ORDER_ID = "ORD-1042";
const REFUND_AMOUNT = 49.99;
const REFUND_REASON = "Item arrived damaged in transit";

const main = async () => {
  // The mock reasoner is scripted deterministically so this example needs no
  // API key and produces the same output every run. It mirrors what a real
  // model would propose for the goal below: look up the order, then request
  // the refund. The refund is requested twice — the engine auto-blocks the
  // first request (no approval yet) and consumes it; after a human approves,
  // the agent naturally asks again on its next turn and it goes through.
  const reasoner = createMockReasoner({
    responses: [
      { actionName: ACTION_NAMES.lookupOrder, input: { orderId: ORDER_ID } },
      {
        actionName: ACTION_NAMES.issueRefund,
        input: { orderId: ORDER_ID, amount: REFUND_AMOUNT, reason: REFUND_REASON },
      },
      {
        actionName: ACTION_NAMES.issueRefund,
        input: { orderId: ORDER_ID, amount: REFUND_AMOUNT, reason: REFUND_REASON },
      },
    ],
  });

  // ── Wiring a real model instead (optional) ────────────────────────────────
  // Swap the mock reasoner above for a real one by passing `models` instead of
  // `reasoner`, e.g.:
  //
  //   const delta = await createDeltaEngine({
  //     models: [{ name: "default", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY, default: true }],
  //   });
  //
  // Everything else in this file — actions, agent, send/approve/resume/inspect
  // — stays exactly the same either way. That independence (governance never
  // changes with the reasoning backend) is the whole point of delta-agents.
  const delta = await createDeltaEngine({
    reasoner,
    systemPrompt: "You are Acme Corp's order support agent. Always be helpful and concise.",
  });

  const supportAgent = createSupportAgent(delta);
  delta.deploy(supportAgent);

  console.log(`\n--- sending goal to "${AGENT_NAME}" ---`);
  const sendResult = await delta.send({
    goal: `Look up order ${ORDER_ID} and refund the customer — the item arrived damaged.`,
    agentName: AGENT_NAME,
  });

  if (sendResult.isErr) {
    console.error("send failed:", sendResult.error);
    process.exit(1);
  }

  let outcome = sendResult.value;
  console.log(`send() -> status: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);

  // The refund requires human sign-off, so the task is expected to come back
  // "blocked" here. Find the pending approval and approve it.
  if (outcome.status === "blocked") {
    const inspection = await delta.inspect(outcome.taskId);
    if (inspection.isErr) {
      console.error("inspect failed:", inspection.error);
      process.exit(1);
    }

    const pending = inspection.value.pendingApprovals.find((a) => a.action === ACTION_NAMES.issueRefund);
    if (pending === undefined) {
      console.error("expected a pending approval for issue-refund, found none");
      process.exit(1);
    }

    console.log(`\n--- human review ---`);
    console.log(`approval requested: "${pending.reason}"`);
    console.log(`approving approval ${pending.id}...`);

    const approveResult = await delta.approve(pending.id);
    if (approveResult.isErr) {
      console.error("approve failed:", approveResult.error);
      process.exit(1);
    }

    console.log(`\n--- resuming task ${outcome.taskId} ---`);
    const resumeResult = await delta.resume(outcome.taskId);
    if (resumeResult.isErr) {
      console.error("resume failed:", resumeResult.error);
      process.exit(1);
    }

    outcome = resumeResult.value;
    console.log(`resume() -> status: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  // ── Audit trail ────────────────────────────────────────────────────────────
  console.log(`\n--- audit trail for task ${outcome.taskId} ---`);
  const finalInspection = await delta.inspect(outcome.taskId);
  if (finalInspection.isErr) {
    console.error("inspect failed:", finalInspection.error);
    process.exit(1);
  }

  const { task, executions, escalations, pendingApprovals } = finalInspection.value;
  console.log(`task status: ${task.status}`);
  console.log(`trust score: ${task.trust.score.toFixed(2)} (${task.trust.successfulExecutions} ok / ${task.trust.failedExecutions} failed)`);
  console.log(`current risk: ${task.risk.currentRisk.toFixed(2)} (static prior: ${task.risk.staticRisk})`);
  console.log(`executions (${executions.length}):`);
  for (const execution of executions) {
    console.log(`  - ${execution.action}: ${execution.status}`);
  }
  console.log(`escalations: ${escalations.length}, still-pending approvals: ${pendingApprovals.length}`);
};

main().catch((error: unknown) => {
  console.error("unhandled error:", error);
  process.exit(1);
});
