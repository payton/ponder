import Emittery from "emittery";
import { decodeEventLog, type Hex } from "viem";

import type { LogEventMetadata } from "@/config/abi.js";
import type { Network } from "@/config/networks.js";
import type { Source } from "@/config/sources.js";
import { sourceIsFactory, sourceIsLogFilter } from "@/config/sources.js";
import type { Common } from "@/Ponder.js";
import type { SyncStore } from "@/sync-store/store.js";
import type { Block } from "@/types/block.js";
import type { Log } from "@/types/log.js";
import type { Transaction } from "@/types/transaction.js";
import { formatShortDate } from "@/utils/date.js";

export type LogEvent = {
  eventSourceName: string;
  eventName: string;
  args: any;
  log: Log;
  block: Block;
  transaction: Transaction;
  chainId: number;
};

type SyncGatewayEvents = {
  /**
   * Emitted when a new event checkpoint is reached. This is the minimum timestamp
   * at which events are available across all registered networks.
   */
  newCheckpoint: { timestamp: number };
  /**
   * Emitted when a new finality checkpoint is reached. This is the minimum timestamp
   * at which events are finalized across all registered networks.
   */
  newFinalityCheckpoint: { timestamp: number };
  /**
   * Emitted when a reorg has been detected on any registered network.
   */
  reorg: { commonAncestorTimestamp: number };
};

type SyncGatewayMetrics = {};

export class SyncGateway extends Emittery<SyncGatewayEvents> {
  private common: Common;
  private syncStore: SyncStore;
  private networks: Network[];
  private sources: Source[];

  // Minimum timestamp at which events are available (across all networks).
  checkpoint: number;
  // Minimum finalized timestamp (across all networks).
  finalityCheckpoint: number;

  // Timestamp at which the historical sync was completed (across all networks).
  historicalSyncCompletedAt?: number;

  // Per-network event timestamp checkpoints.
  private networkCheckpoints: Record<
    number,
    {
      isHistoricalSyncComplete: boolean;
      historicalCheckpoint: number;
      realtimeCheckpoint: number;
      finalityCheckpoint: number;
    }
  >;

  metrics: SyncGatewayMetrics;

  constructor({
    common,
    syncStore,
    networks,
    sources = [],
  }: {
    common: Common;
    syncStore: SyncStore;
    networks: Network[];
    sources?: Source[];
  }) {
    super();

    this.common = common;
    this.syncStore = syncStore;
    this.networks = networks;
    this.sources = sources;
    this.metrics = {};

    this.checkpoint = 0;
    this.finalityCheckpoint = 0;

    this.networkCheckpoints = {};
    this.networks.forEach((network) => {
      this.networkCheckpoints[network.chainId] = {
        isHistoricalSyncComplete: false,
        historicalCheckpoint: 0,
        realtimeCheckpoint: 0,
        finalityCheckpoint: 0,
      };
    });
  }

  /** Fetches events for all registered log filters between the specified timestamps.
   *
   * @param options.fromTimestamp Timestamp to start including events (inclusive).
   * @param options.toTimestamp Timestamp to stop including events (inclusive).
   * @param options.includeLogFilterEvents Map of log filter name -> selector -> ABI event item for which to include full event objects.
   * @returns A promise resolving to an array of log events.
   */
  async *getEvents({
    fromTimestamp,
    toTimestamp,
    indexingMetadata,
  }: {
    fromTimestamp: number;
    toTimestamp: number;
    indexingMetadata: {
      [eventSourceName: string]:
        | {
            bySelector: { [selector: Hex]: LogEventMetadata };
          }
        | undefined;
    };
  }) {
    const iterator = this.syncStore.getLogEvents({
      fromTimestamp,
      toTimestamp,
      logFilters: this.sources.filter(sourceIsLogFilter).map((logFilter) => ({
        name: logFilter.name,
        chainId: logFilter.chainId,
        criteria: logFilter.criteria,
        fromBlock: logFilter.startBlock,
        toBlock: logFilter.endBlock,
        includeEventSelectors: Object.keys(
          indexingMetadata[logFilter.name]?.bySelector ?? {},
        ) as Hex[],
      })),
      factories: this.sources.filter(sourceIsFactory).map((factory) => ({
        name: factory.name,
        chainId: factory.chainId,
        criteria: factory.criteria,
        fromBlock: factory.startBlock,
        toBlock: factory.endBlock,
        includeEventSelectors: Object.keys(
          indexingMetadata[factory.name]?.bySelector ?? {},
        ) as Hex[],
      })),
    });

    for await (const page of iterator) {
      const { events, metadata } = page;

      const decodedEvents = events.reduce<LogEvent[]>((acc, event) => {
        const selector = event.log.topics[0];
        if (!selector) {
          throw new Error(
            `Received an event log with no selector: ${event.log}`,
          );
        }

        const logEventMetadata =
          indexingMetadata[event.eventSourceName]?.bySelector[selector];
        if (!logEventMetadata) {
          throw new Error(
            `Metadata for event ${event.eventSourceName}:${selector} not found in includeEvents`,
          );
        }
        const { abiItem, safeName } = logEventMetadata;

        try {
          const decodedLog = decodeEventLog({
            abi: [abiItem],
            data: event.log.data,
            topics: event.log.topics,
          });

          acc.push({
            eventSourceName: event.eventSourceName,
            eventName: safeName,
            args: decodedLog.args || {},
            log: event.log,
            block: event.block,
            transaction: event.transaction,
            chainId: event.chainId,
          });
        } catch (err) {
          // TODO: emit a warning here that a log was not decoded.
          this.common.logger.error({
            service: "app",
            msg: `Unable to decode log, skipping it. id: ${event.log.id}, data: ${event.log.data}, topics: ${event.log.topics}`,
            error: err as Error,
          });
        }

        return acc;
      }, []);

      yield { events: decodedEvents, metadata };
    }
  }

  handleNewHistoricalCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].historicalCheckpoint = timestamp;

    this.common.logger.trace({
      service: "gateway",
      msg: `New historical checkpoint at ${timestamp} [${formatShortDate(
        timestamp,
      )}] (chainId=${chainId})`,
    });

    this.recalculateCheckpoint();
  };

  handleHistoricalSyncComplete = ({ chainId }: { chainId: number }) => {
    this.networkCheckpoints[chainId].isHistoricalSyncComplete = true;
    this.recalculateCheckpoint();

    // If every network has completed the historical sync, set the metric.
    const networkCheckpoints = Object.values(this.networkCheckpoints);
    if (networkCheckpoints.every((n) => n.isHistoricalSyncComplete)) {
      const maxHistoricalCheckpoint = Math.max(
        ...networkCheckpoints.map((n) => n.historicalCheckpoint),
      );
      this.historicalSyncCompletedAt = maxHistoricalCheckpoint;

      this.common.logger.debug({
        service: "gateway",
        msg: `Completed historical sync across all networks`,
      });
    }
  };

  handleNewRealtimeCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].realtimeCheckpoint = timestamp;

    this.common.logger.trace({
      service: "gateway",
      msg: `New realtime checkpoint at ${timestamp} [${formatShortDate(
        timestamp,
      )}] (chainId=${chainId})`,
    });

    this.recalculateCheckpoint();
  };

  handleNewFinalityCheckpoint = ({
    chainId,
    timestamp,
  }: {
    chainId: number;
    timestamp: number;
  }) => {
    this.networkCheckpoints[chainId].finalityCheckpoint = timestamp;
    this.recalculateFinalityCheckpoint();
  };

  handleReorg = ({
    commonAncestorTimestamp,
  }: {
    commonAncestorTimestamp: number;
  }) => {
    this.emit("reorg", { commonAncestorTimestamp });
  };

  private recalculateCheckpoint = () => {
    const checkpoints = Object.values(this.networkCheckpoints).map((n) =>
      n.isHistoricalSyncComplete
        ? Math.max(n.historicalCheckpoint, n.realtimeCheckpoint)
        : n.historicalCheckpoint,
    );
    const newCheckpoint = Math.min(...checkpoints);

    if (newCheckpoint > this.checkpoint) {
      this.checkpoint = newCheckpoint;

      this.common.logger.trace({
        service: "gateway",
        msg: `New event checkpoint at ${this.checkpoint} [${formatShortDate(
          this.checkpoint,
        )}]`,
      });

      this.emit("newCheckpoint", { timestamp: this.checkpoint });
    }
  };

  private recalculateFinalityCheckpoint = () => {
    const newFinalityCheckpoint = Math.min(
      ...Object.values(this.networkCheckpoints).map(
        (n) => n.finalityCheckpoint,
      ),
    );

    if (newFinalityCheckpoint > this.finalityCheckpoint) {
      this.finalityCheckpoint = newFinalityCheckpoint;

      this.common.logger.trace({
        service: "gateway",
        msg: `New finality checkpoint at ${
          this.finalityCheckpoint
        } [${formatShortDate(this.finalityCheckpoint)}]`,
      });

      this.emit("newFinalityCheckpoint", {
        timestamp: this.finalityCheckpoint,
      });
    }
  };
}