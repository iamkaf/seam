import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("strict update mutation flow", () => {
  it("requires expectedVersion, increments version, and appends seq_log", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
        "task.toggle": {
          record: "task",
          input: z.object({ done: z.boolean() }),
          execute: (input: { done: boolean }, { current }) => ({
            writes: [
              {
                op: "update",
                id: current.id,
                type: "task",
                expectedVersion: current.version,
                data: { ...current.data, done: input.done },
              },
            ],
          }),
        },
      },
    });

    const createResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Ship updates" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    const updateResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          expectedVersion: created.record.version,
          input: { done: true },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const updated = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      ok: true,
      seq: 2,
      clientMutationId: "client_mutation_2",
      record: {
        id: created.record.id,
        type: "task",
        version: 2,
        data: { title: "Ship updates", done: true },
        scopeKind: "list",
        scopeId: "inbox",
        createdBy: "user_1",
        updatedBy: "user_1",
      },
    });
    expect(db.seqLogEntries()).toHaveLength(2);
    expect(db.seqLogEntries()[1]).toMatchObject({
      seq: 2,
      recordType: "task",
      recordId: created.record.id,
      mutationType: "task.toggle",
      actorId: "user_1",
      version: 2,
    });
  });

  it("returns VERSION_CONFLICT with the current record for a stale expectedVersion", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
        "task.toggle": {
          record: "task",
          input: z.object({ done: z.boolean() }),
          execute: (input: { done: boolean }, { current }) => ({
            writes: [
              {
                op: "update",
                id: current.id,
                type: "task",
                expectedVersion: current.version,
                data: { ...current.data, done: input.done },
              },
            ],
          }),
        },
      },
    });

    const createResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Conflict me" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          expectedVersion: 1,
          input: { done: true },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );

    const staleResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          expectedVersion: 1,
          input: { done: false },
          clientMutationId: "client_mutation_3",
        }),
      }),
    );
    const stale = await staleResponse.json();

    expect(staleResponse.status).toBe(400);
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        record: {
          id: created.record.id,
          version: 2,
          data: { title: "Conflict me", done: true },
        },
      },
      clientMutationId: "client_mutation_3",
    });
    expect(db.seqLogEntries()).toHaveLength(2);
  });

  it("soft deletes records and rejects later mutations against the deleted record", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
        "task.toggle": {
          record: "task",
          input: z.object({ done: z.boolean() }),
          execute: (input: { done: boolean }, { current }) => ({
            writes: [
              {
                op: "update",
                id: current.id,
                type: "task",
                expectedVersion: current.version,
                data: { ...current.data, done: input.done },
              },
            ],
          }),
        },
        "task.delete": {
          record: "task",
          input: z.object({}),
          execute: (_input: Record<string, never>, { current }) => ({
            writes: [
              {
                op: "delete",
                id: current.id,
                type: "task",
                expectedVersion: current.version,
              },
            ],
          }),
        },
      },
    });

    const createResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Delete me" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    const deleteResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.delete",
          id: created.record.id,
          expectedVersion: created.record.version,
          input: {},
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const deleted = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleted).toMatchObject({
      ok: true,
      seq: 2,
      record: {
        id: created.record.id,
        version: 2,
        deletedAt: expect.any(String),
      },
    });
    expect(db.seqLogEntries()[1]).toMatchObject({
      mutationType: "task.delete",
      recordId: created.record.id,
      version: 2,
    });

    const afterDeleteResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          expectedVersion: 2,
          input: { done: true },
          clientMutationId: "client_mutation_3",
        }),
      }),
    );
    const afterDelete = await afterDeleteResponse.json();

    expect(afterDeleteResponse.status).toBe(400);
    expect(afterDelete).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
      clientMutationId: "client_mutation_3",
    });
    expect(db.seqLogEntries()).toHaveLength(2);
  });

  it("rejects record mutations without expectedVersion before appending seq_log", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
        "task.toggle": {
          record: "task",
          input: z.object({ done: z.boolean() }),
          execute: (input: { done: boolean }, { current }) => ({
            writes: [
              {
                op: "update",
                id: current.id,
                type: "task",
                expectedVersion: current.version,
                data: { ...current.data, done: input.done },
              },
            ],
          }),
        },
      },
    });

    const createResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Needs version" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    const missingVersionResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          input: { done: true },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const missingVersion = await missingVersionResponse.json();

    expect(missingVersionResponse.status).toBe(400);
    expect(missingVersion).toMatchObject({
      ok: false,
      error: { code: "INVALID" },
      clientMutationId: "client_mutation_2",
    });
    expect(db.seqLogEntries()).toHaveLength(1);
  });

  it("returns TYPE_MISMATCH for authorized records with a different type", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });
    const Note = defineRecordType("note", {
      schema: z.object({ body: z.string() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task, Note],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
        "note.update": {
          record: "note",
          input: z.object({ body: z.string() }),
          execute: (input: { body: string }, { current }) => ({
            writes: [
              {
                op: "update",
                id: current.id,
                type: "note",
                expectedVersion: current.version,
                data: { body: input.body },
              },
            ],
          }),
        },
      },
    });

    const createResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Wrong type" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    const mismatchResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "note.update",
          id: created.record.id,
          expectedVersion: created.record.version,
          input: { body: "not a task" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const mismatch = await mismatchResponse.json();

    expect(mismatchResponse.status).toBe(400);
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "TYPE_MISMATCH" },
      clientMutationId: "client_mutation_2",
    });
    expect(db.seqLogEntries()).toHaveLength(1);
  });
});
