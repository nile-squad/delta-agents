import { createDeltaEngine, createMockReasoner } from "delta-agents";
import { createSupportAgent, createFulfillmentAgent, ACTIONS, AGENT_NAME, WF_NAME } from "./agents/support-agent";

const ORDER_ID = "ORD-1042";

const main = async () => {
  const apiKey = process.env.OPENAI_API_KEY;

  // With OPENAI_API_KEY set, the engine uses a real model (gpt-4o-mini).
  // Without one, it falls back to a mock reasoner so the example runs
  // deterministically with no external dependencies.
  const delta = apiKey
    ? await createDeltaEngine({
        apiKey,
        models: [{ name: "default", model: "gpt-4o-mini", default: true }],
        systemPrompt: "You are Acme Corp's order support agent. Always be helpful and concise.",
      })
    : await createDeltaEngine({
        reasoner: createMockReasoner({
          responses: [
            { actionName: ACTIONS.lookupOrder, input: { orderId: ORDER_ID } },
            { actionName: ACTIONS.issueRefund, input: { orderId: ORDER_ID, amount: 49.99, reason: "Item arrived damaged in transit" } },
            { actionName: ACTIONS.issueRefund, input: { orderId: ORDER_ID, amount: 49.99, reason: "Item arrived damaged in transit" } },
          ],
        }),
        systemPrompt: "You are Acme Corp's order support agent.",
      });

  // ── Pattern 1: free-loop with human oversight ────────────────────────────────
  const supportAgent = createSupportAgent(delta);
  delta.deploy(supportAgent);

  console.log(`\n--- free-loop: sending goal to "${AGENT_NAME}" ---`);
  const sendResult = await delta.send({
    goal: `Look up order ${ORDER_ID} and refund the customer — the item arrived damaged.`,
    agentName: AGENT_NAME,
  });

  if (sendResult.isErr) {
    console.error("send failed:", sendResult.error);
    process.exit(1);
  }

  let outcome = sendResult.value;
  console.log(`send() → ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);

  // The refund requires human sign-off. Find the pending approval, approve it,
  // then resume the task. The engine picks up exactly where it left off.
  if (outcome.status === "blocked") {
    const inspection = await delta.inspect(outcome.taskId);
    if (inspection.isErr) { console.error("inspect failed:", inspection.error); process.exit(1); }

    const pending = inspection.value.pendingApprovals.find((a) => a.action === ACTIONS.issueRefund);
    if (pending === undefined) { console.error("expected pending approval for issue-refund"); process.exit(1); }

    console.log(`\n--- human review ---`);
    console.log(`approval requested: ${pending.reason}`);
    console.log(`approving ${pending.id}...`);
    await delta.approve(pending.id);

    console.log(`resuming task ${outcome.taskId}...`);
    const resumeResult = await delta.resume(outcome.taskId);
    if (resumeResult.isErr) { console.error("resume failed:", resumeResult.error); process.exit(1); }
    outcome = resumeResult.value;
    console.log(`resume() → ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);

    const finalInspection = await delta.inspect(outcome.taskId);
    if (finalInspection.isErr) { console.error("inspect failed:", finalInspection.error); process.exit(1); }
    const { task, executions } = finalInspection.value;
    console.log(`\naudit trail:`);
    console.log(`  status: ${task.status}`);
    console.log(`  trust: ${task.trust.score.toFixed(2)}`);
    console.log(`  actions: ${executions.map((e) => e.action).join(", ")}`);
  }

  // ── Pattern 2: deterministic workflow ────────────────────────────────────────
  // Workflows run phases in declared order with no model involvement in routing.
  // The same action set, but executed deterministically.
  const fulfillmentAgent = createFulfillmentAgent(delta);
  delta.deploy(fulfillmentAgent);

  console.log(`\n--- workflow: sending goal to "fulfillment-agent" ---`);
  const wfResult = await delta.send({
    goal: `Fulfill order ${ORDER_ID}`,
    agentName: "fulfillment-agent",
    workflow: WF_NAME,
    input: { orderId: ORDER_ID },
  });

  if (wfResult.isErr) {
    console.error("workflow send failed:", wfResult.error);
    process.exit(1);
  }

  const wfOutcome = wfResult.value;
  console.log(`workflow send() → ${wfOutcome.status}${wfOutcome.reason ? ` (${wfOutcome.reason})` : ""}`);

  const wfInspection = await delta.inspect(wfOutcome.taskId);
  if (wfInspection.isErr) { console.error("inspect failed:", wfInspection.error); process.exit(1); }
  console.log(`  phases: ${wfInspection.value.task.currentPhase ?? "done"}`);
  console.log(`  actions: ${wfInspection.value.executions.map((e) => e.action).join(", ")}`);
};

main().catch((error: unknown) => {
  console.error("unhandled error:", error);
  process.exit(1);
});
