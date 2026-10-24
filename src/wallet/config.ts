import { mainnet, anvil, type Chain } from "viem/chains";
import { createTransport, fallback } from "viem";
import { createConfig, http, injected, type Transport } from "wagmi";
import { getChainRpcUrl, isLocalNode, RPC_FALLBACK_URLS, RPC_URL } from "../constants/config";
import { getResolvedRpcBaseUrl } from "../utils/rpc-runtime";

export { getChainRpcUrl };

export const supportedChains: readonly [Chain, ...Chain[]] = isLocalNode ? [mainnet, anvil] : [mainnet];

type ChainId = (typeof supportedChains)[number]["id"];
type TransportsMap = Record<ChainId, Transport>;

/** Bound every RPC transport so a stalled endpoint cannot hold a request open. */
const RPC_TRANSPORT_TIMEOUT_MS = 2_000;

/**
 * Returns the base URLs that should back a chain transport: the primary alone in
 * local-node mode (Anvil does not serve chain paths), otherwise the primary followed
 * by the configured public fallbacks with duplicates removed.
 */
export function getRpcTransportUrls(
  chain: Chain,
  {
    fallbackUrls = RPC_FALLBACK_URLS,
    localNode = isLocalNode,
    rpcUrl = RPC_URL,
  }: {
    fallbackUrls?: readonly string[];
    localNode?: boolean;
    rpcUrl?: string;
  } = {}
): string[] {
  const rpcUrls = localNode ? [rpcUrl] : [rpcUrl, ...fallbackUrls];
  return [...new Set(rpcUrls.map((currentRpcUrl) => getChainRpcUrl(currentRpcUrl, chain.id, localNode)))];
}

/**
 * Creates an HTTP transport instance for a given RPC URL.
 *
 * @param rpcUrl The target RPC endpoint URL.
 * @returns An HTTP transport configured for the current environment.
 */
function createRpcTransport(rpcUrl: string): Transport {
  return http(rpcUrl, {
    batch: !isLocalNode,
    timeout: RPC_TRANSPORT_TIMEOUT_MS,
  });
}

/**
 * Creates a dynamic RPC transport for a chain that resolves the active RPC endpoint
 * per-request and falls back cleanly if multiple URLs are configured.
 *
 * @param chain Target chain configuration.
 * @returns A viem transport factory.
 */
export function dynamicRpcTransport(chain: Chain): Transport {
  return (params) => {
    return createTransport({
      key: "dynamic-rpc",
      name: "Dynamic RPC Transport",
      type: "dynamicRpc",
      timeout: RPC_TRANSPORT_TIMEOUT_MS,
      retryCount: 0,
      async request(args) {
        const selectedRpcUrl = getResolvedRpcBaseUrl() || RPC_URL;
        const rpcUrls = getRpcTransportUrls(chain, { rpcUrl: selectedRpcUrl });
        const transportFactories = rpcUrls.map((url) => createRpcTransport(url));

        if (transportFactories.length === 1) {
          const client = transportFactories[0](params);
          return client.request(args);
        }

        const fallbackTransport = fallback(transportFactories, {
          rank: false,
          retryCount: params.retryCount,
        })(params);
        return fallbackTransport.request(args);
      },
    });
  };
}

// Anvil doesn't support URLs like http://localhost:8545/31337
const transports = supportedChains.reduce<TransportsMap>((acc, chain) => {
  acc[chain.id] = dynamicRpcTransport(chain);
  return acc;
}, {} as TransportsMap);

export const wagmiConfig = createConfig({
  chains: supportedChains,
  transports,
  connectors: [injected()],
  batch: {
    multicall: false, // Disabled because rpc.ubq.fi already uses multicall
  },
});
