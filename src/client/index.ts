import type { SeamRecord, SeamScope } from "../shared/types.js";

export interface CreateSeamClientOptions {
  url: string;
  fetch?: typeof fetch;
}

export interface BootstrapRequest {
  scopes: SeamScope[];
}

export interface BootstrapResponse {
  records: SeamRecord[];
  seq: number;
  revokedScopes?: SeamScope[];
}

export interface PullRequest {
  afterSeq: number;
  scopes: SeamScope[];
  untilSeq?: number;
}

export interface PullResponse {
  records: SeamRecord[];
  seq: number;
  hasMore: boolean;
  revokedScopes?: SeamScope[];
}

export interface ProjectionOptions<T> {
  scope: SeamScope;
  select(records: SeamRecord[]): T;
}

export interface MutateOptions {
  id?: string;
  expectedVersion?: number;
  clientMutationId?: string;
  optimistic?: {
    records: SeamRecord[];
  };
}

export interface MutateResponse {
  ok: boolean;
  records?: SeamRecord[];
  record?: SeamRecord;
  seq?: number;
  clientMutationId: string;
  error?: {
    code: string;
    message: string;
    record?: SeamRecord;
  };
}

export interface ClientSnapshot {
  cursor: number;
  records: SeamRecord[];
  activeScopes: SeamScope[];
  isPending: boolean;
}

type ClientListener = () => void;

interface PendingMutation {
  order: number;
  clientMutationId: string;
  recordIds: string[];
  aborted: boolean;
}

export function createSeamClient(options: CreateSeamClientOptions) {
  const request = options.fetch ?? fetch;
  const store = new Map<string, SeamRecord>();
  const listeners = new Set<ClientListener>();
  let cursor = 0;
  let activeScopes: SeamScope[] = [];
  let pendingMutations = 0;
  let mutationOrder = 0;
  const pending = new Map<string, PendingMutation>();
  let snapshot = createSnapshot(store, cursor, activeScopes);

  return {
    async bootstrap(body: BootstrapRequest): Promise<BootstrapResponse> {
      const previousCursor = cursor;
      const previousScopes = activeScopes;
      const bootstrap = await post<BootstrapResponse>(
        request,
        `${options.url}/sync/bootstrap`,
        body,
      );

      mergeRecords(store, bootstrap.records);
      cursor = bootstrap.seq;
      activeScopes = mergeScopes(activeScopes, body.scopes, bootstrap.revokedScopes ?? []);
      updateSnapshot();

      if (previousScopes.length > 0 && previousCursor < bootstrap.seq) {
        cursor = previousCursor;
        await pullUntil(previousScopes, bootstrap.seq);
      }

      return bootstrap;
    },
    async sync(): Promise<void> {
      await pullUntil(activeScopes);
    },
    async mutate(
      mutation: string,
      input: Record<string, unknown>,
      mutateOptions: MutateOptions = {},
    ): Promise<MutateResponse> {
      const optimisticIds = mutateOptions.optimistic?.records.map((record) => record.id) ?? [];
      const clientMutationId = mutateOptions.clientMutationId ?? crypto.randomUUID();
      const pendingMutation: PendingMutation = {
        order: (mutationOrder += 1),
        clientMutationId,
        recordIds: optimisticIds,
        aborted: false,
      };
      pending.set(clientMutationId, pendingMutation);
      pendingMutations += 1;
      updateSnapshot();

      if (mutateOptions.optimistic) {
        mergeRecords(store, mutateOptions.optimistic.records);
        updateSnapshot();
      }

      const body = {
        mutation,
        input,
        ...(mutateOptions.id ? { id: mutateOptions.id } : {}),
        ...(mutateOptions.expectedVersion !== undefined
          ? { expectedVersion: mutateOptions.expectedVersion }
          : {}),
        clientMutationId,
      };
      const response = await post<MutateResponse>(request, `${options.url}/mutate`, body);

      if (!pendingMutation.aborted) {
        for (const id of optimisticIds) {
          store.delete(id);
        }
      }

      if (response.error?.record) {
        abortDependentMutations(pending, pendingMutation, response.error.record.id);
      }

      if (!pendingMutation.aborted && response.records) {
        mergeRecords(store, response.records);
      }

      if (!pendingMutation.aborted && response.error?.record) {
        mergeRecords(store, [response.error.record]);
      }

      if (!pendingMutation.aborted && response.seq !== undefined) {
        cursor = response.seq;
      }

      pending.delete(clientMutationId);
      pendingMutations -= 1;
      updateSnapshot();

      return response;
    },
    cursor: () => cursor,
    records: () => [...store.values()],
    activeScopes: () => [...activeScopes],
    subscribe(listener: ClientListener): () => void {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    project<T>(projection: ProjectionOptions<T>): T {
      return projection.select(
        [...store.values()].filter(
          (record) =>
            !record.deletedAt &&
            record.scopeKind === projection.scope.kind &&
            record.scopeId === projection.scope.id,
        ),
      );
    },
  };

  async function pullUntil(scopes: SeamScope[], untilSeq?: number): Promise<void> {
    let hasMore = scopes.length > 0;

    while (hasMore) {
      const body: PullRequest = {
        afterSeq: cursor,
        scopes,
      };

      if (untilSeq !== undefined) {
        body.untilSeq = untilSeq;
      }

      const pull = await post<PullResponse>(request, `${options.url}/sync/pull`, body);

      mergeRecords(store, pull.records);
      activeScopes = removeScopes(activeScopes, pull.revokedScopes ?? []);
      cursor = pull.seq;
      updateSnapshot();
      hasMore = pull.hasMore;
    }
  }

  function updateSnapshot(): void {
    snapshot = createSnapshot(store, cursor, activeScopes, pendingMutations > 0);
    notify(listeners);
  }
}

function abortDependentMutations(
  pending: Map<string, PendingMutation>,
  failed: PendingMutation,
  recordId: string,
): void {
  for (const mutation of pending.values()) {
    if (mutation.order > failed.order && mutation.recordIds.includes(recordId)) {
      mutation.aborted = true;
    }
  }
}

export type SeamClient = ReturnType<typeof createSeamClient>;

async function post<T>(request: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return (await response.json()) as T;
}

function mergeRecords(store: Map<string, SeamRecord>, records: SeamRecord[]): void {
  for (const record of records) {
    if (record.deletedAt) {
      store.delete(record.id);
    } else {
      store.set(record.id, record);
    }
  }
}

function mergeScopes(current: SeamScope[], next: SeamScope[], revoked: SeamScope[]): SeamScope[] {
  const scopes = new Map(current.map((scope) => [scopeKey(scope), scope]));

  for (const scope of next) {
    scopes.set(scopeKey(scope), scope);
  }

  for (const scope of revoked) {
    scopes.delete(scopeKey(scope));
  }

  return [...scopes.values()];
}

function removeScopes(current: SeamScope[], revoked: SeamScope[]): SeamScope[] {
  const revokedKeys = new Set(revoked.map(scopeKey));

  return current.filter((scope) => !revokedKeys.has(scopeKey(scope)));
}

function scopeKey(scope: SeamScope): string {
  return `${scope.kind}:${scope.id}`;
}

function createSnapshot(
  store: Map<string, SeamRecord>,
  cursor: number,
  activeScopes: SeamScope[],
  isPending = false,
): ClientSnapshot {
  return {
    cursor,
    records: [...store.values()],
    activeScopes: [...activeScopes],
    isPending,
  };
}

function notify(listeners: Set<ClientListener>): void {
  for (const listener of listeners) {
    listener();
  }
}
