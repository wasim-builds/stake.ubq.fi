import { afterEach, describe, expect, it } from "bun:test";
import { anvil, mainnet } from "viem/chains";

import { MAINNET_RPC_FALLBACK_URL, RPC_FALLBACK_URLS, RPC_URL } from "../src/constants/config";
import { dynamicRpcTransport, getChainRpcUrl, getRpcTransportUrls } from "../src/wallet/config";
import { __resetRpcRuntimeForTests, __setResolvedRpcBaseUrlForTests } from "../src/utils/rpc-runtime";

describe("getChainRpcUrl", () => {
  it("appends the chain id to mainnet RPC endpoints", () => {
    expect(getChainRpcUrl("https://rpc.ubq.fi", 1, false)).toBe("https://rpc.ubq.fi/1");
    expect(getChainRpcUrl("https://rpc.ubq.fi/", 1, false)).toBe("https://rpc.ubq.fi/1");
  });

  it("keeps local-node RPC endpoints raw and unsuffixed", () => {
    expect(getChainRpcUrl("http://localhost:8545", 31337, true)).toBe("http://localhost:8545");
    expect(getChainRpcUrl("http://localhost:8545/", 31337, true)).toBe("http://localhost:8545");
  });

  it("keeps query strings after the chain path", () => {
    expect(getChainRpcUrl("https://rpc.example/rpc?key=abc", 1, false)).toBe("https://rpc.example/rpc/1?key=abc");
  });
});

describe("getRpcTransportUrls", () => {
  it("returns the primary and fallback URLs with the chain suffix", () => {
    expect(
      getRpcTransportUrls(mainnet, {
        fallbackUrls: ["https://fallback.example"],
        localNode: false,
        rpcUrl: "https://primary.example",
      })
    ).toEqual(["https://primary.example/1", "https://fallback.example/1"]);
  });

  it("deduplicates a fallback that matches the primary", () => {
    expect(
      getRpcTransportUrls(mainnet, {
        fallbackUrls: [MAINNET_RPC_FALLBACK_URL],
        localNode: false,
        rpcUrl: MAINNET_RPC_FALLBACK_URL,
      })
    ).toEqual([`${MAINNET_RPC_FALLBACK_URL}/1`]);
  });

  it("skips fallback endpoints for local-node transports", () => {
    expect(
      getRpcTransportUrls(anvil, {
        fallbackUrls: [MAINNET_RPC_FALLBACK_URL],
        localNode: true,
        rpcUrl: "http://localhost:8545",
      })
    ).toEqual(["http://localhost:8545"]);
  });

  it("defaults to the resolved config primary and fallbacks", () => {
    const urls = getRpcTransportUrls(mainnet);

    expect(urls[0]).toBe(`${RPC_URL}/1`);
    for (const fallbackUrl of RPC_FALLBACK_URLS) {
      expect(urls).toContain(`${fallbackUrl}/1`);
    }
  });
});

describe("dynamicRpcTransport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetRpcRuntimeForTests();
  });

  it("passes unevaluated transport functions to fallback and exercises the fallback endpoint (Issue #42)", async () => {
    const calledUrls: string[] = [];

    const parseId = (init?: RequestInit) => {
      try {
        if (!init?.body || typeof init.body !== "string") return { isBatch: false, id: 1 };
        const parsed = JSON.parse(init.body);
        if (Array.isArray(parsed)) return { isBatch: true, id: parsed[0]?.id ?? 1 };
        return { isBatch: false, id: parsed?.id ?? 1 };
      } catch {
        return { isBatch: false, id: 1 };
      }
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      const { isBatch, id } = parseId(init);

      if (url.startsWith("https://failing-primary.example")) {
        const errPayload = { jsonrpc: "2.0", id, error: { code: -32603, message: "Primary failed" } };
        return new Response(JSON.stringify(isBatch ? [errPayload] : errPayload), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      const okPayload = { jsonrpc: "2.0", id, result: "0x12345" };
      return new Response(JSON.stringify(isBatch ? [okPayload] : okPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    __setResolvedRpcBaseUrlForTests("https://failing-primary.example");

    const transportFactory = dynamicRpcTransport(mainnet);
    const client = transportFactory({ chain: mainnet });

    const result = await client.request({ method: "eth_blockNumber" });

    expect(result).toBe("0x12345");
    expect(calledUrls.length).toBeGreaterThanOrEqual(2);
    expect(calledUrls[0]).toContain("https://failing-primary.example/1");
    expect(calledUrls[1]).toContain(MAINNET_RPC_FALLBACK_URL);
  });

  it("resolves the selected RPC when each request is made on an existing client (Issue #43)", async () => {
    const calledUrls: string[] = [];

    const parseId = (init?: RequestInit) => {
      try {
        if (!init?.body || typeof init.body !== "string") return { isBatch: false, id: 1 };
        const parsed = JSON.parse(init.body);
        if (Array.isArray(parsed)) return { isBatch: true, id: parsed[0]?.id ?? 1 };
        return { isBatch: false, id: parsed?.id ?? 1 };
      } catch {
        return { isBatch: false, id: 1 };
      }
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      const { isBatch, id } = parseId(init);
      const okPayload = { jsonrpc: "2.0", id, result: "0xabc" };
      return new Response(JSON.stringify(isBatch ? [okPayload] : okPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    __setResolvedRpcBaseUrlForTests("https://primary-initial.example");

    const transportFactory = dynamicRpcTransport(mainnet);
    // Create the client once (mimicking wagmi memoization)
    const client = transportFactory({ chain: mainnet });

    // Request 1: uses initial endpoint
    await client.request({ method: "eth_blockNumber" });
    expect(calledUrls[0]).toContain("https://primary-initial.example/1");

    // Probe completes in background and selects new fallback endpoint
    __setResolvedRpcBaseUrlForTests("https://secondary-resolved.example");

    // Request 2: made on the SAME client instance immediately hits the updated endpoint
    await client.request({ method: "eth_blockNumber" });
    expect(calledUrls[1]).toContain("https://secondary-resolved.example/1");
  });
});
