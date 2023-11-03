import type { Abi, AbiEvent } from "abitype";
import type { Transport } from "viem";

type ContractRequired = {
  /** Contract name. Must be unique across `contracts` and `filters`. */
  name: string;
  /**
   * Network that this contract is deployed to. Must match a network name in `networks`.
   * Any filter information overrides the values in the higher level "contracts" property. Factories cannot override an address and vice versa.
   */
  network: ({ name: string } & Partial<ContractFilter>)[];
  abi: Abi;
};

type ContractFilter = (
  | {
      /** Contract address. */
      address?: `0x${string}`;
    }
  | {
      /** Factory contract configuration. */
      factory: {
        /** Address of the factory contract that creates this contract. */
        address: `0x${string}`;
        /** ABI event that announces the creation of a new instance of this contract. */
        event: AbiEvent;
        /** Name of the factory event parameter that contains the new child contract address. */
        parameter: string; // TODO: Narrow type to known parameter names from `event`.
      };
    }
) & {
  /** Block number at which to start indexing events (inclusive). Default: `0`. */
  startBlock?: number;
  /** Block number at which to stop indexing events (inclusive). If `undefined`, events will be processed in real-time. Default: `undefined`. */
  endBlock?: number;
  /** Maximum block range to use when calling `eth_getLogs`. Default: `10_000`. */
  maxBlockRange?: number;

  event?:
    | {
        signature: AbiEvent;
        args: any[];
      }
    | AbiEvent[];
};

export type ResolvedConfig = {
  /** Database to use for storing blockchain & entity data. Default: `"postgres"` if `DATABASE_URL` env var is present, otherwise `"sqlite"`. */
  database?:
    | {
        kind: "sqlite";
        /** Path to SQLite database file. Default: `"./.ponder/cache.db"`. */
        filename?: string;
      }
    | {
        kind: "postgres";
        /** PostgreSQL database connection string. Default: `process.env.DATABASE_URL`. */
        connectionString?: string;
      };
  /** List of blockchain networks. */
  networks: {
    /** Network name. Must be unique across all networks. */
    name: string;
    /** Chain ID of the network. */
    chainId: number;
    /** A viem `http`, `webSocket`, or `fallback` [Transport](https://viem.sh/docs/clients/transports/http.html).
     *
     * __To avoid rate limiting, include a custom RPC URL.__ Usage:
     *
     * ```ts
     * import { http } from "viem";
     *
     * const network = {
     *    name: "mainnet",
     *    chainId: 1,
     *    transport: http("https://eth-mainnet.g.alchemy.com/v2/..."),
     * }
     * ```
     */
    transport: Transport;
    /** Polling frequency (in ms). Default: `1_000`. */
    pollingInterval?: number;
    /** Maximum concurrency of RPC requests during the historical sync. Default: `10`. */
    maxRpcRequestConcurrency?: number;
  }[];
  /** List of contracts to sync & index events from. Contracts defined here will be present in `context.contracts`. */
  contracts?: (ContractRequired & ContractFilter)[];
  /** Configuration for Ponder internals. */
  options?: {
    /** Maximum number of seconds to wait for event processing to be complete before responding as healthy. If event processing exceeds this duration, the API may serve incomplete data. Default: `240` (4 minutes). */
    maxHealthcheckDuration?: number;
  };
};

export type Config =
  | ResolvedConfig
  | Promise<ResolvedConfig>
  | (() => ResolvedConfig)
  | (() => Promise<ResolvedConfig>);
