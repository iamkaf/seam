# Seam Tutorial

## 1. Install

```bash
npm install @iamkaf/seam zod
```

## 2. Add Tables

Run Seam's D1 schema migration in your app database.

```bash
npx seam init d1
npx wrangler d1 migrations apply <database>
```

## 3. Define Records And Mutations

```ts
import { createSeamServer, defineRecordType, SeamError } from '@iamkaf/seam/server';
import { z } from 'zod';

const Task = defineRecordType('task', {
  schema: z.object({ title: z.string(), done: z.boolean(), position: z.string() }),
});

export const seam = createSeamServer({
  records: [Task],
  resolveContext: async (request) => {
    const user = await getUser(request);
    return user ? { actorId: user.id, actorType: 'user' } : { actorId: null, actorType: 'anonymous' };
  },
  authorize: async ({ ctx, scope, action }) => canAccess(ctx.actorId, scope, action),
  mutations: {
    'task.create': {
      input: z.object({ listId: z.string(), title: z.string() }),
      scope: (input) => ({ kind: 'list', id: input.listId }),
      authorize: (ctx) => ctx.hasRole('editor'),
      execute: (input) => ({
        writes: [{ op: 'create', type: 'task', scope: { kind: 'list', id: input.listId }, data: { title: input.title, done: false, position: 'm' } }],
      }),
    },
    'task.toggle': {
      record: 'task',
      input: z.object({ done: z.boolean() }),
      authorize: (ctx) => ctx.hasRole('editor'),
      execute: (input, { current }) => {
        if (!current) throw new SeamError('NOT_FOUND');
        return { writes: [{ op: 'update', id: current.id, type: 'task', expectedVersion: current.version, data: { ...current.data, done: input.done } }] };
      },
    },
  },
});
```

## 4. Mount Routes

```ts
export default {
  fetch: seam.fetch,
};
```

## 5. Use The Client

```tsx
import { SeamProvider, useSeamMutation, useSeamProjection } from '@iamkaf/seam/react';

function App() {
  return <SeamProvider url="/seam" scopes={[{ kind: 'list', id: 'inbox' }]}><Tasks /></SeamProvider>;
}

function Tasks() {
  const tasks = useSeamProjection({
    scope: { kind: 'list', id: 'inbox' },
    select: (records) => records.filter((r) => r.type === 'task').toSorted((a, b) => a.data.position.localeCompare(b.data.position)),
  });
  const toggle = useSeamMutation('task.toggle');

  return tasks.map((task) => (
    <button key={task.id} onClick={() => toggle.mutate({ done: !task.data.done }, { id: task.id, expectedVersion: task.version })}>
      {task.data.done ? '[x] ' : ''}{task.data.title}
    </button>
  ));
}
```

## 6. Sync Rules

- Use scopes for permission and sync boundaries.
- Send `clientMutationId` on every mutation; the client generates it by default.
- Pass `expectedVersion` for updates and deletes.
- Use `importRecords()` for large setup or import flows.

## 7. Durable App Events

Mutation commits can include app events. Seam writes them to the durable outbox in the same batch as records and `seq_log` rows.

Outbox consumers process rows with at-least-once delivery. Consumers must be idempotent: if processing fails before the cursor advances, the same row is delivered again on the next `consumeOutbox()` call.
