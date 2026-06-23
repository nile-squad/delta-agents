/**
 * DataSource authoring tests (#3).
 *
 * A DataSource bundles governed CRUD operations over one store. Each operation is
 * a full Action, so it is validated and governed exactly like any other action.
 * These tests cover definition-time validation, registration, the ownership and
 * authentication metadata, and the key integration property: an agent's attached
 * data sources have their operations flattened into the agent's reachable action
 * set, so nothing downstream needs to special-case a data operation (ADR-007).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../../src/engine";

const makeEngine = () => createDeltaEngine();

const retrieveOp = (delta: ReturnType<typeof makeEngine>) =>
  delta.action({
    name: "user-db.retrieve",
    description: "read a user record",
    schema: z.object({ id: z.string() }),
    risk: 2,
    fn: async () => Ok("record"),
  });

describe("delta.dataSource — definition and validation", () => {
  it("registers a valid data source and returns it unchanged", () => {
    const delta = makeEngine();
    const ds = delta.dataSource({
      name: "user-db",
      description: "the user store",
      ownership: "internal",
      contentType: "application/json",
      actions: { retrieve: retrieveOp(delta) },
    });
    expect(ds.name).toBe("user-db");
    expect(ds.ownership).toBe("internal");
  });

  it("accepts an authentication descriptor (mechanism only, never a secret)", () => {
    const delta = makeEngine();
    const ds = delta.dataSource({
      name: "partner-api",
      description: "external partner data",
      ownership: "external",
      contentType: "application/json",
      authentication: { type: "oauth2" },
      actions: { retrieve: retrieveOp(delta) },
    });
    expect(ds.authentication?.type).toBe("oauth2");
  });

  it("rejects a data source with no operations", () => {
    const delta = makeEngine();
    expect(() =>
      delta.dataSource({
        name: "empty",
        description: "no ops",
        ownership: "internal",
        contentType: "application/json",
        actions: {},
      }),
    ).toThrow(/at least one operation/);
  });

  it("rejects an invalid ownership value", () => {
    const delta = makeEngine();
    expect(() =>
      delta.dataSource({
        name: "bad-own",
        description: "d",
        // @ts-expect-error — exercising the runtime guard with an illegal value
        ownership: "public",
        contentType: "application/json",
        actions: { retrieve: retrieveOp(delta) },
      }),
    ).toThrow(/ownership must be/);
  });

  it("rejects an empty contentType", () => {
    const delta = makeEngine();
    expect(() =>
      delta.dataSource({
        name: "no-ct",
        description: "d",
        ownership: "internal",
        contentType: "  ",
        actions: { retrieve: retrieveOp(delta) },
      }),
    ).toThrow(/contentType/);
  });

  it("rejects an authentication descriptor with an empty type", () => {
    const delta = makeEngine();
    expect(() =>
      delta.dataSource({
        name: "bad-auth",
        description: "d",
        ownership: "external",
        contentType: "application/json",
        authentication: { type: "" },
        actions: { retrieve: retrieveOp(delta) },
      }),
    ).toThrow(/authentication.type/);
  });
});

describe("delta.agent — data source operations join the reachable action set", () => {
  it("flattens every attached data source operation into the agent's actions", () => {
    const delta = makeEngine();
    const retrieve = delta.action({
      name: "user-db.retrieve",
      description: "read",
      schema: z.object({}),
      fn: async () => Ok("r"),
    });
    const create = delta.action({
      name: "user-db.create",
      description: "write",
      schema: z.object({}),
      fn: async () => Ok("c"),
    });
    const userDb = delta.dataSource({
      name: "user-db",
      description: "the user store",
      ownership: "internal",
      contentType: "application/json",
      actions: { retrieve, create },
    });
    const plain = delta.action({
      name: "greet",
      description: "say hi",
      schema: z.object({}),
      fn: async () => Ok("hi"),
    });

    const agent = delta.agent({
      name: "data-agent",
      description: "uses a data source",
      role: "R",
      rolePrompt: ".",
      actions: [plain],
      dataSources: [userDb],
    });

    const names = agent.actions.map((a) => a.name).sort();
    expect(names).toEqual(["greet", "user-db.create", "user-db.retrieve"]);
    // The data source metadata is preserved on the agent for audit/inspection.
    expect(agent.dataSources?.[0]?.ownership).toBe("internal");
  });

  it("does not duplicate an operation also listed directly in actions", () => {
    const delta = makeEngine();
    const retrieve = delta.action({
      name: "user-db.retrieve",
      description: "read",
      schema: z.object({}),
      fn: async () => Ok("r"),
    });
    const userDb = delta.dataSource({
      name: "user-db",
      description: "store",
      ownership: "internal",
      contentType: "application/json",
      actions: { retrieve },
    });

    const agent = delta.agent({
      name: "dedupe-agent",
      description: "lists the op twice",
      role: "R",
      rolePrompt: ".",
      actions: [retrieve],
      dataSources: [userDb],
    });

    expect(agent.actions.filter((a) => a.name === "user-db.retrieve")).toHaveLength(1);
  });
});
