import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("scoped sync", () => {
  it("bootstraps current records for requested scopes with the global seq watermark", async () => {
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
      },
    });

    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Visible" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "other", title: "Hidden" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );

    const response = await seam.fetch(
      new Request("https://example.com/seam/sync/bootstrap", {
        method: "POST",
        body: JSON.stringify({ scopes: [{ kind: "list", id: "inbox" }] }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      records: [
        {
          type: "task",
          version: 1,
          data: { title: "Visible", done: false },
          scopeKind: "list",
          scopeId: "inbox",
        },
      ],
      seq: 2,
    });
  });

  it("pulls scoped changes and coalesces multiple changes to one record", async () => {
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
          input: { listId: "inbox", title: "Coalesce me" },
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
    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.toggle",
          id: created.record.id,
          expectedVersion: 2,
          input: { done: false },
          clientMutationId: "client_mutation_3",
        }),
      }),
    );

    const response = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          afterSeq: 0,
          scopes: [{ kind: "list", id: "inbox" }],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      records: [
        {
          id: created.record.id,
          type: "task",
          version: 3,
          data: { title: "Coalesce me", done: false },
          scopeKind: "list",
          scopeId: "inbox",
        },
      ],
      seq: 3,
      hasMore: false,
    });
  });

  it("supports limit and advances no-change bounded pulls to untilSeq", async () => {
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
      },
    });

    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "First" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Second" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );

    const limitedResponse = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          afterSeq: 0,
          scopes: [{ kind: "list", id: "inbox" }],
          limit: 1,
        }),
      }),
    );
    const limited = await limitedResponse.json();

    expect(limited).toMatchObject({
      records: [{ data: { title: "First", done: false } }],
      seq: 1,
      hasMore: true,
    });

    const boundedNoChangeResponse = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          afterSeq: 0,
          scopes: [{ kind: "list", id: "empty" }],
          untilSeq: 2,
        }),
      }),
    );
    const boundedNoChange = await boundedNoChangeResponse.json();

    expect(boundedNoChange).toEqual({ records: [], seq: 2, hasMore: false });
  });

  it("does not advance past an unmaterializable record version", async () => {
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
          input: { listId: "inbox", title: "Replica lag" },
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
    db.forceRecordVersion(created.record.id, 1);

    const response = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          afterSeq: 0,
          scopes: [{ kind: "list", id: "inbox" }],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ records: [], seq: 0, hasMore: true });
  });
});
