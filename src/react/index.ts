import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createSeamClient, type SeamClient } from "../client/index.js";
import type { SeamRecord, SeamScope } from "../shared/types.js";

interface SeamProviderProps {
  url: string;
  scopes: SeamScope[];
  fetch?: typeof fetch;
  children?: ReactNode;
}

interface ProjectionOptions<T> {
  scope: SeamScope;
  select(records: SeamRecord[]): T;
}

interface MutationOptions {
  id?: string;
  expectedVersion?: number;
  clientMutationId?: string;
  optimistic?: {
    records: SeamRecord[];
  };
}

const SeamContext = createContext<SeamClient | null>(null);

export function SeamProvider(props: SeamProviderProps) {
  const client = useMemo(
    () => createSeamClient({ url: props.url, fetch: props.fetch }),
    [props.url, props.fetch],
  );

  useEffect(() => {
    void client.bootstrap({ scopes: props.scopes }).then(() => client.sync());
  }, [client, props.scopes]);

  return React.createElement(SeamContext.Provider, { value: client }, props.children);
}

export function useSeamProjection<T>(projection: ProjectionOptions<T>): T {
  const client = useSeamClient();

  useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  return client.project(projection);
}

export function useSeamList(scope: SeamScope): SeamRecord[] {
  return useSeamProjection({
    scope,
    select: (records) => records,
  });
}

export function useSeamMutation(mutation: string) {
  const client = useSeamClient();
  const [data, setData] = useState<Awaited<ReturnType<SeamClient["mutate"]>> | undefined>();
  const [error, setError] = useState<Awaited<ReturnType<SeamClient["mutate"]>>["error"]>();
  const [isPending, setIsPending] = useState(false);

  return {
    data,
    error,
    isPending,
    async mutate(input: Record<string, unknown>, options: MutationOptions = {}) {
      setIsPending(true);
      setError(undefined);

      const response = await client.mutate(mutation, input, options);

      setData(response);
      setError(response.error);
      setIsPending(false);

      return response;
    },
  };
}

export function useSeamStatus() {
  const client = useSeamClient();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  return { isPending: snapshot.isPending, cursor: snapshot.cursor };
}

export function useSeamClient(): SeamClient {
  const client = useContext(SeamContext);

  if (!client) {
    throw new Error("SeamProvider is required");
  }

  return client;
}
