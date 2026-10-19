import { getChainRpcUrl, isLocalNode, LOCAL_NODE_CHAIN_ID, RPC_FALLBACK_URLS, RPC_URL } from "../constants/config";
import { DEFAULT_RPC_HEALTH_TIMEOUT_MS, rpcHealthCheck, type RpcHealthStatus } from "./rpc-health";

export type RpcRuntimeState = {
  resolvedRpcUrl: string;
  lastChainId?: number;
  lastStatus: RpcHealthStatus | "unknown";
  recentErrorCount: number;
  initialized: boolean;
};

export type InitializeRpcRuntimeOptions = {
  candidates?: readonly string[];
  expectedChainId?: number;
  fetcher?: typeof fetch;
  localNode?: boolean;
};

const MAINNET_CHAIN_ID = 1;

const listeners = new Set<() => void>();
let generation = 0;
let state: RpcRuntimeState = createInitialState();

function createInitialState(): RpcRuntimeState {
  return {
    resolvedRpcUrl: RPC_URL,
    lastStatus: "unknown",
    recentErrorCount: 0,
    initialized: false,
  };
}

const publish = (patch: Partial<RpcRuntimeState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const subscribeRpcRuntime = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Stable snapshot for useSyncExternalStore consumers. */
export const getRpcRuntimeState = (): RpcRuntimeState => state;
export const getResolvedRpcBaseUrl = (): string => state.resolvedRpcUrl;

export const __resetRpcRuntimeForTests = () => {
  generation += 1;
  state = createInitialState();
  listeners.forEach((listener) => listener());
};

export const __setResolvedRpcBaseUrlForTests = (url: string) => {
  publish({ resolvedRpcUrl: url });
};

/**
 * Probes the candidate base URLs in order and keeps the first healthy one.
 * Every run starts from a clean slate, and a run that is superseded by a newer
 * initialization or a test reset stops publishing so stale selections cannot leak.
 */
export async function initializeRpcRuntime(options: InitializeRpcRuntimeOptions = {}): Promise<RpcRuntimeState> {
  const currentGeneration = ++generation;
  const localNode = options.localNode ?? isLocalNode;
  const expectedChainId = options.expectedChainId ?? (localNode ? LOCAL_NODE_CHAIN_ID : MAINNET_CHAIN_ID);
  const candidates = [...new Set(options.candidates ?? [RPC_URL, ...RPC_FALLBACK_URLS])].filter((candidate) => candidate.length > 0);
  const primaryRpcUrl = candidates[0] ?? RPC_URL;

  publish({ ...createInitialState(), resolvedRpcUrl: primaryRpcUrl });

  for (const baseUrl of candidates) {
    const result = await rpcHealthCheck(getChainRpcUrl(baseUrl, expectedChainId, localNode), {
      expectedChainId,
      fetcher: options.fetcher,
      timeoutMs: DEFAULT_RPC_HEALTH_TIMEOUT_MS,
    });

    if (currentGeneration !== generation) {
      return getRpcRuntimeState();
    }

    if (result.status === "healthy") {
      if (baseUrl !== primaryRpcUrl) {
        console.warn(`[rpc-runtime] Primary RPC failed the quick health check. Falling back to "${baseUrl}".`);
      }
      publish({ lastStatus: result.status, lastChainId: result.chainId, resolvedRpcUrl: baseUrl, initialized: true });
      return getRpcRuntimeState();
    }

    publish({ lastStatus: result.status, lastChainId: result.chainId, recentErrorCount: state.recentErrorCount + 1 });
  }

  publish({ initialized: true });
  console.warn(`[rpc-runtime] All RPC candidates failed the quick health check. Keeping "${primaryRpcUrl}" and relying on the transport fallback.`);
  return getRpcRuntimeState();
}
