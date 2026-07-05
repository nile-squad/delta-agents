import { createDeltaEngine } from "delta-agents";
import { createSupportAgent, createFulfillmentAgent, ACTIONS, AGENT_NAME, WF_NAME } from "./agents/support-agent";

const ORDER_ID = "ORD-1042";

const main = async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY to run this example against a real model.");
    process.exit(1);
  }

  const delta = await createDeltaEngine({
    apiKey,
    models: [{ name: "default", model: "gpt-4o-mini", default: true }],
    systemPrompt:
      "You are Acme Corp's order support agent. Always be helpful and concise.",
  });

  // ── HITL: events drive the human review loop ─────────────────────────────
  let approvalResolve!: (id: string) => void;
  const approvalPromise = new Promise<string>((resolve) => {
    approvalResolve = resolve;
  });

  delta.events.on("approval-requested", async ({ approvalId, reason }) => {
    console.log(`\n--- approval requested ---`);
    console.log(`  reason: ${reason}`);
    const approved = await reviewInDashboard(approvalId);
    if (approved) {
      await delta.approve(approvalId);
      console.log(`  approved`);
    } else {
      await delta.reject(approvalId, "rejected by reviewer");
      console.log(`  rejected`);
    }
    approvalResolve(approvalId);
  });

  // ── Pattern 1: free-loop with human oversight ────────────────────────────
  const supportAgent = createSupportAgent(delta);
  delta.deploy(supportAgent);

  console.log(`\n--- free-loop: sending goal to "${AGENT_NAME}" ---`);
  const sendResult = await delta.send({
    goal: `Look up order ${ORDER_ID} and refund the customer. The item arrived damaged.`,
    agentName: AGENT_NAME,
  });

  if (sendResult.isErr) {
    console.error("send failed:", sendResult.error);
    process.exit(1);
  }

  let outcome = sendResult.value;
  console.log(`send() → ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);

  // The refund action requires human sign-off. The approval-requested event
  // fires during engine execution; the reviewer approves or rejects asynchronously.
  // Wait for that decision before resuming the blocked task.
  if (outcome.status === "blocked") {
    await approvalPromise;
    console.log(`\n--- resuming after review ---`);
    const resumeResult = await delta.resume(outcome.taskId);
    if (resumeResult.isErr) {
      console.error("resume failed:", resumeResult.error);
      process.exit(1);
    }
    outcome = resumeResult.value;
    console.log(`resume() → ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  const inspection = await delta.inspect(outcome.taskId);
  if (inspection.isErr) { console.error("inspect failed:", inspection.error); process.exit(1); }
  const { task, executions } = inspection.value;
  console.log(`\naudit trail:`);
  console.log(` status: ${task.status}`);
  console.log(` trust: ${task.trust.score.toFixed(2)}`);
  console.log(` actions: ${executions.map((e) => e.action).join(", ")}`);

  // ── Pattern 2: deterministic workflow ─────────────────────────────────────
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
  console.log(` phases: ${wfInspection.value.task.currentPhase ?? "done"}`);
  console.log(` actions: ${wfInspection.value.executions.map((e) => e.action).join(", ")}`);
};

// Review stub — replace with a real UI, Slack prompt, or CI gate.
const reviewInDashboard = async (_approvalId: string): Promise<boolean> => true;

main().catch((error: unknown) => {
  console.error("unhandled error:", error);
  process.exit(1);
});
