import React, { useMemo } from "react";
import { z } from "zod";
import { createSeamClient, type SeamClient } from "../../../src/client/index.js";
import { SeamProvider, useSeamMutation, useSeamProjection } from "../../../src/react/index.js";
import { createSeamServer, defineRecordType } from "../../../src/server/index.js";
import { createTestD1, migrateSeamD1 } from "../../../src/testing/index.js";
import type { SeamRecord } from "../../../src/shared/types.js";

interface TodoAppProps {
  client: SeamClient;
  onRender?: (titles: string[], actions: TodoActions) => void;
}

interface TodoActions {
  createTask(title: string): Promise<void>;
  toggleFirst(): Promise<void>;
}

const inbox = { kind: "list", id: "inbox" };

export async function createTodoExample() {
  const db = createTestD1();
  await migrateSeamD1(db);
  const server = createTodoServer(db);
  const client = createSeamClient({
    url: "https://example.com/seam",
    fetch: (request, init) => server.fetch(new Request(request, init)),
  });

  return { client, server, db };
}

export function TodoApp(props: TodoAppProps): React.ReactElement {
  return React.createElement(
    SeamProvider,
    { client: props.client, scopes: [] },
    React.createElement(TodoList, { onRender: props.onRender }),
  );
}

function TodoList(props: Pick<TodoAppProps, "onRender">): React.ReactElement {
  const tasks = useSeamProjection<SeamRecord[]>({
    scope: inbox,
    select: (records) =>
      [...records]
        .filter((record) => record.type === "task")
        .sort((left, right) =>
          String(left.data.position).localeCompare(String(right.data.position)),
        ),
  });
  const createTask = useSeamMutation("task.create");
  const toggleTask = useSeamMutation("task.toggle");
  const actions = useMemo<TodoActions>(
    () => ({
      async createTask(title: string) {
        await createTask.mutate(
          { listId: inbox.id, title },
          {
            optimistic: {
              records: [
                {
                  id: `tmp_${title}`,
                  type: "task",
                  version: 1,
                  data: { title, done: false, position: String(Date.now()) },
                  scopeKind: inbox.kind,
                  scopeId: inbox.id,
                  createdAt: new Date(0).toISOString(),
                  createdBy: "client",
                  updatedAt: new Date(0).toISOString(),
                  updatedBy: "client",
                },
              ],
            },
          },
        );
      },
      async toggleFirst() {
        const task = tasks[0];

        if (!task) {
          return;
        }

        await toggleTask.mutate(
          { done: !task.data.done },
          {
            id: task.id,
            expectedVersion: task.version,
            optimistic: {
              records: [
                {
                  ...task,
                  version: task.version + 1,
                  data: { ...task.data, done: !task.data.done },
                },
              ],
            },
          },
        );
      },
    }),
    [createTask, tasks, toggleTask],
  );
  const titles = tasks.map(
    (task: SeamRecord) => `${task.data.done ? "[x] " : ""}${task.data.title}`,
  );

  props.onRender?.(titles, actions);

  return React.createElement(
    "ul",
    null,
    titles.map((title: string) => React.createElement("li", { key: title }, title)),
  );
}

function createTodoServer(db: ReturnType<typeof createTestD1>) {
  const Task = defineRecordType("task", {
    schema: z.object({ title: z.string(), done: z.boolean(), position: z.string() }),
  });

  return createSeamServer({
    db,
    records: [Task],
    resolveContext: async () => ({ actorId: "example_user", actorType: "user" }),
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
              data: { title: input.title, done: false, position: String(Date.now()) },
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
}
