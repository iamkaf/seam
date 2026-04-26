import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SeamRecord } from "../shared/types.js";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("authorization hooks", () => {
  it.each(["token", "service"] as const)(
    "accepts %s actors from resolveContext",
    async (actorType) => {
      const db = createTestD1();
      await migrateSeamD1(db);

      const Task = defineRecordType("task", {
        schema: z.object({ title: z.string(), done: z.boolean() }),
      });

      const seam = createSeamServer({
        db,
        records: [Task],
        resolveContext: async () => ({ actorId: `${actorType}_1`, actorType }),
        authorize: async () => true,
        mutations: {
          "task.create": {
            input: z.object({ listId: z.string(), title: z.string() }),
            scope: (input: { listId: string; title: string }) => ({
              kind: "list",
              id: input.listId,
            }),
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

      const response = await seam.fetch(
        new Request("https://example.com/seam/mutate", {
          method: "POST",
          body: JSON.stringify({
            mutation: "task.create",
            input: { listId: "inbox", title: actorType },
            clientMutationId: `client_mutation_${actorType}`,
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.record).toMatchObject({
        createdBy: `${actorType}_1`,
        updatedBy: `${actorType}_1`,
      });
    },
  );

  it("allows anonymous public bootstrap but rejects anonymous mutations", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const adminSeam = createSeamServer({
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
          }),
        },
      },
    });

    await adminSeam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "public", title: "Readable" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    await adminSeam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "private", title: "Hidden" },
          clientMutationId: "client_mutation_private",
        }),
      }),
    );

    const anonymousSeam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: null, actorType: "anonymous" }),
      authorize: async ({ scope, action }) =>
        action === "bootstrap" && scope.kind === "list" && scope.id === "public",
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

    const bootstrapResponse = await anonymousSeam.fetch(
      new Request("https://example.com/seam/sync/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          scopes: [
            { kind: "list", id: "public" },
            { kind: "list", id: "private" },
          ],
        }),
      }),
    );
    const bootstrap = await bootstrapResponse.json();

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrap).toMatchObject({
      records: [{ data: { title: "Readable", done: false } }],
      seq: 2,
      revokedScopes: [{ kind: "list", id: "private" }],
    });

    const mutateResponse = await anonymousSeam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "public", title: "Nope" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const mutate = await mutateResponse.json();

    expect(mutateResponse.status).toBe(400);
    expect(mutate).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
      clientMutationId: "client_mutation_2",
    });
    expect(db.records).toHaveLength(2);
  });

  it("rejects unauthorized creates with FORBIDDEN before writing", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async ({ action }) => action !== "create",
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

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "private", title: "Denied" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
      clientMutationId: "client_mutation_1",
    });
    expect(db.records).toHaveLength(0);
    expect(db.seqLogEntries()).toHaveLength(0);
  });

  it("omits unauthorized pull scopes and reports them as revoked", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async ({ action, scope }) => action !== "pull" || scope.id === "public",
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
          input: { listId: "public", title: "Visible" },
          clientMutationId: "client_mutation_public",
        }),
      }),
    );
    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "private", title: "Hidden" },
          clientMutationId: "client_mutation_private",
        }),
      }),
    );

    const response = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          afterSeq: 0,
          scopes: [
            { kind: "list", id: "public" },
            { kind: "list", id: "private" },
          ],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      records: [{ data: { title: "Visible", done: false } }],
      seq: 1,
      hasMore: false,
      revokedScopes: [{ kind: "list", id: "private" }],
    });
  });

  it("returns NOT_FOUND for unauthorized existing-record mutations before type or version checks", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });
    const Note = defineRecordType("note", {
      schema: z.object({ body: z.string() }),
    });
    const mutations = {
      "task.create": {
        input: z.object({ listId: z.string(), title: z.string() }),
        scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
        execute: (input: { listId: string; title: string }) => ({
          writes: [
            {
              op: "create" as const,
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
        execute: (input: { body: string }, { current }: { current: SeamRecord }) => ({
          writes: [
            {
              op: "update" as const,
              id: current.id,
              type: "note",
              expectedVersion: current.version,
              data: { body: input.body },
            },
          ],
        }),
      },
    };

    const adminSeam = createSeamServer({
      db,
      records: [Task, Note],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations,
    });

    const createResponse = await adminSeam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "private", title: "Protected" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const created = await createResponse.json();

    const restrictedSeam = createSeamServer({
      db,
      records: [Task, Note],
      resolveContext: async () => ({ actorId: "user_2", actorType: "user" }),
      authorize: async ({ action }) => action !== "mutate",
      mutations,
    });

    const response = await restrictedSeam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "note.update",
          id: created.record.id,
          expectedVersion: 999,
          input: { body: "wrong type and version" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
      clientMutationId: "client_mutation_2",
    });
    expect(db.seqLogEntries()).toHaveLength(1);
  });
});
