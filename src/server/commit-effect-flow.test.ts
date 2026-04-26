import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("commit effects", () => {
  it("runs app-owned effects in the mutation batch without extra seq_log rows", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);
    db.createAppTable("task_index");

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: input.title, done: false },
              },
            ],
            effects: [
              db.prepareAppInsert("task_index", { listId: input.listId, title: input.title }),
            ],
          }),
        },
      },
    });

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Indexed" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(db.appRows("task_index")).toEqual([{ listId: "inbox", title: "Indexed" }]);
    expect(db.seqLogEntries()).toHaveLength(1);
  });

  it("rolls back record writes and seq_log when a commit effect fails", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: input.title, done: false },
              },
            ],
            effects: [db.prepareAppInsert("missing_index", { title: input.title })],
          }),
        },
      },
    });

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Rollback" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(db.records).toHaveLength(0);
    expect(db.seqLogEntries()).toHaveLength(0);
    expect(db.receiptEntries()).toHaveLength(0);
  });

  it("rejects commit effects that target Seam core tables", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: input.title, done: false },
              },
            ],
            effects: [
              {
                tableName: "records",
                execute: () => undefined,
              },
            ],
          }),
        },
      },
    });

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Core write" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(db.records).toHaveLength(0);
    expect(db.seqLogEntries()).toHaveLength(0);
    expect(db.receiptEntries()).toHaveLength(0);
  });
});
