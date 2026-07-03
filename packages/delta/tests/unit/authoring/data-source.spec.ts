/**
 * DataSource authoring tests (#3).
 *
 * A DataSource bundles governed CRUD operations over one store. The factory is the
 * sole registrar of its operations, so ownership can shape the risk prior at
 * registration time. These tests cover definition-time validation, the ownership
 * trust posture (external is less trusted by default and must earn it back), and
 * the integration property that an agent's attached data sources have their
 * operations flattened into the agent's reachable action set (ADR-007).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../../src/engine";
import { ownershipAdjustedRisk, EXTERNAL_RISK_FLOOR } from "../../../src/authoring";

const makeEngine = () => createDeltaEngine();

describe("delta.dataSource — definition and validation", () => {
  it("registers a valid data source and returns it unchanged", async () => {
    const delta = await makeEngine();
    const ds = delta.dataSource({
      name: "user-db",
      description: "the user store",
      ownership: "internal",
      contentType: "application/json",
      actions: {
        retrieve: {
          name: "user-db.retrieve",
          description: "read a user record",
          schema: z.object({ id: z.string() }),
          fn: async () => Ok("record"),
        },
      },
    });
    expect(ds.name).toBe("user-db");
    expect(ds.ownership).toBe("internal");
  });

  it("accepts an authentication descriptor (mechanism only, never a secret)", async () => {
    const delta = await makeEngine();
    const ds = delta.dataSource({
      name: "partner-api",
      description: "external partner data",
      ownership: "external",
      contentType: "application/json",
      authentication: { type: "oauth2" },
      actions: {
        retrieve: {
          name: "partner-api.retrieve",
          description: "read partner data",
          schema: z.object({}),
          fn: async () => Ok("record"),
        },
      },
    });
    expect(ds.authentication?.type).toBe("oauth2");
  });

  it("rejects a data source with no operations", async () => {
    const delta = await makeEngine();
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

  it("rejects an invalid ownership value", async () => {
    const delta = await makeEngine();
    expect(() =>
      delta.dataSource({
        name: "bad-own",
        description: "d",
        // @ts-expect-error — exercising the runtime guard with an illegal value
        ownership: "public",
        contentType: "application/json",
        actions: {
          retrieve: { name: "bad-own.retrieve", description: "r", schema: z.object({}), fn: async () => Ok("r") },
        },
      }),
    ).toThrow(/ownership must be/);
  });

  it("rejects an empty contentType", async () => {
    const delta = await makeEngine();
    expect(() =>
      delta.dataSource({
        name: "no-ct",
        description: "d",
        ownership: "internal",
        contentType: "  ",
        actions: {
          retrieve: { name: "no-ct.retrieve", description: "r", schema: z.object({}), fn: async () => Ok("r") },
        },
      }),
    ).toThrow(/contentType/);
  });

  it("rejects an authentication descriptor with an empty type", async () => {
    const delta = await makeEngine();
    expect(() =>
      delta.dataSource({
        name: "bad-auth",
        description: "d",
        ownership: "external",
        contentType: "application/json",
        authentication: { type: "" },
        actions: {
          retrieve: { name: "bad-auth.retrieve", description: "r", schema: z.object({}), fn: async () => Ok("r") },
        },
      }),
    ).toThrow(/authentication.type/);
  });
});

describe("ownership shapes the risk prior — external is less trusted", () => {
  it("computes the adjusted risk prior per ownership", async () => {
    // Internal: declared risk passes through unchanged (undefined stays a cold start).
    expect(ownershipAdjustedRisk("internal", 2)).toBe(2);
    expect(ownershipAdjustedRisk("internal", undefined)).toBeUndefined();
    // External: floored at the moderate external floor; a higher declared risk wins.
    expect(ownershipAdjustedRisk("external", undefined)).toBe(EXTERNAL_RISK_FLOOR);
    expect(ownershipAdjustedRisk("external", 1)).toBe(EXTERNAL_RISK_FLOOR);
    expect(ownershipAdjustedRisk("external", 5)).toBe(5);
  });

  it("raises the risk prior on an external source's operations", async () => {
    const delta = await makeEngine();
    const ds = delta.dataSource({
      name: "partner",
      description: "third party store",
      ownership: "external",
      contentType: "application/json",
      actions: {
        // Developer rated it low risk, but external data does not get to be low-risk.
        retrieve: {
          name: "partner.retrieve",
          description: "read",
          schema: z.object({}),
          risk: 1,
          fn: async () => Ok("r"),
        },
      },
    });
    expect(ds.actions.retrieve?.risk).toBe(EXTERNAL_RISK_FLOOR);
  });

  it("leaves an internal source's declared risk untouched", async () => {
    const delta = await makeEngine();
    const ds = delta.dataSource({
      name: "internal-db",
      description: "owned store",
      ownership: "internal",
      contentType: "application/json",
      actions: {
        retrieve: {
          name: "internal-db.retrieve",
          description: "read",
          schema: z.object({}),
          risk: 1,
          fn: async () => Ok("r"),
        },
      },
    });
    expect(ds.actions.retrieve?.risk).toBe(1);
  });
});

describe("delta.agent — data source operations join the reachable action set", () => {
  it("flattens every attached data source operation into the agent's actions", async () => {
    const delta = await makeEngine();
    const userDb = delta.dataSource({
      name: "user-db",
      description: "the user store",
      ownership: "internal",
      contentType: "application/json",
      actions: {
        retrieve: { name: "user-db.retrieve", description: "read", schema: z.object({}), fn: async () => Ok("r") },
        create: { name: "user-db.create", description: "write", schema: z.object({}), fn: async () => Ok("c") },
      },
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

  it("does not duplicate an operation also listed directly in actions", async () => {
    const delta = await makeEngine();
    const userDb = delta.dataSource({
      name: "user-db",
      description: "store",
      ownership: "internal",
      contentType: "application/json",
      actions: {
        retrieve: { name: "user-db.retrieve", description: "read", schema: z.object({}), fn: async () => Ok("r") },
      },
    });

    const agent = delta.agent({
      name: "dedupe-agent",
      description: "lists the op twice",
      role: "R",
      rolePrompt: ".",
      // The returned data source's operation object, also listed directly.
      actions: [userDb.actions.retrieve!],
      dataSources: [userDb],
    });

    expect(agent.actions.filter((a) => a.name === "user-db.retrieve")).toHaveLength(1);
  });
});
