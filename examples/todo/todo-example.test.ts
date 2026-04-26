import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { createTodoExample, TodoApp } from "./src/app.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("todo example", () => {
  it("runs server, client, React projection, sync, and optimistic mutation together", async () => {
    const example = await createTodoExample();
    const snapshots: string[][] = [];
    let createTask: ((title: string) => Promise<void>) | undefined;
    let toggleFirst: (() => Promise<void>) | undefined;

    await example.client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });

    await act(async () => {
      create(
        React.createElement(TodoApp, {
          client: example.client,
          onRender: (titles, actions) => {
            snapshots.push(titles);
            createTask = actions.createTask;
            toggleFirst = actions.toggleFirst;
          },
        }),
      );
    });

    await act(async () => {
      await createTask?.("Write tutorial");
    });

    expect(snapshots).toContainEqual(["Write tutorial"]);
    expect(example.client.records()).toHaveLength(1);

    await act(async () => {
      await toggleFirst?.();
    });

    expect(snapshots).toContainEqual(["[x] Write tutorial"]);

    await example.client.sync();

    expect(
      example.client.project({
        scope: { kind: "list", id: "inbox" },
        select: (records) => records.map((record) => record.data.done),
      }),
    ).toEqual([true]);
  });
});
