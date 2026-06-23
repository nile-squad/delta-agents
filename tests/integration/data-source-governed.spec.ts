/**
 * DataSource governance integration (#3).
 *
 * Proves the central claim of the DataSource design: a data operation is governed
 * exactly like any other action. Here a workflow drives a data source's `retrieve`
 * operation through the execution gateway end to end. The operation runs, its
 * schema validates the input, and the run is recorded in the TaskID-attributable
 * audit trail — with no DataSource-specific execution machinery.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createMockReasoner } from "../../src/ports/mock-reasoner";

describe("data source operations run through the gateway (#3)", () => {
  it("executes a retrieve operation via a workflow and records it in the audit trail", async () => {
    const delta = createDeltaEngine({ reasoner: createMockReasoner({ responses: [] }) });

    const reads: string[] = [];
    const userDb = delta.dataSource({
      name: "user-db",
      description: "the user store",
      ownership: "internal",
      contentType: "application/json",
      actions: {
        retrieve: {
          name: "user-db.retrieve",
          description: "read a user record by id",
          schema: z.object({ id: z.string() }),
          fn: async ({ id }) => {
            reads.push(String(id));
            return Ok(`user:${String(id)}`);
          },
        },
      },
    });

    const phase = delta.phase({
      name: "fetch",
      description: "read the user",
      actions: ["user-db.retrieve"],
      checkpoint: true,
    });
    const wf = delta.workflow({ name: "read-user", description: "reads a user", version: "1.0.0", phases: [phase] });

    const agent = delta.agent({
      name: "reader",
      description: "reads users",
      role: "R",
      rolePrompt: ".",
      actions: [],
      dataSources: [userDb],
      workflows: [wf],
    });
    delta.deploy(agent);

    const result = await delta.send({
      goal: "read user 42",
      agentName: "reader",
      workflow: "read-user",
      input: { id: "42" },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(reads).toEqual(["42"]);

    // The data read is in the governed audit trail, attributed to the task.
    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    expect(inspected.value.executions.some((e) => e.action === "user-db.retrieve")).toBe(true);
  });
});
