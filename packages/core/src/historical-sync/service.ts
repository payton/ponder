import Emittery from "emittery";
import {
  type Hash,
  type RpcBlock,
  type RpcLog,
  type RpcTransaction,
  Hex,
  hexToNumber,
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  toHex,
} from "viem";

import type { Factory } from "@/config/factories";
import type { LogFilter, LogFilterCriteria } from "@/config/logFilters";
import type { Network } from "@/config/networks";
import { Source } from "@/config/sources";
import type { EventStore } from "@/event-store/store";
import type { Common } from "@/Ponder";
import { formatEta, formatPercentage } from "@/utils/format";
import {
  BlockProgressTracker,
  getChunks,
  intervalDifference,
  intervalSum,
  ProgressTracker,
} from "@/utils/interval";
import { type Queue, type Worker, createQueue } from "@/utils/queue";
import { hrTimeToMs, startClock } from "@/utils/timer";

import { validateHistoricalBlockRange } from "./utils";

type HistoricalSyncEvents = {
  /**
   * Emitted when the service has finished processing all historical sync tasks.
   */
  syncComplete: undefined;
  /**
   * Emitted when the minimum cached timestamp among all registered event sources moves forward.
   * This indicates to consumers that the connected event store now contains a complete history
   * of events for all registered event sources between their start block and this timestamp (inclusive).
   */
  historicalCheckpoint: { blockNumber: number; blockTimestamp: number };
};

type LogFilterTask = {
  kind: "LOG_FILTER";
  logFilter: LogFilter;
  fromBlock: number;
  toBlock: number;
};

type FactoryChildAddressTask = {
  kind: "FACTORY_CHILD_ADDRESS";
  factory: Factory;
  fromBlock: number;
  toBlock: number;
};

type FactoryLogFilterTask = {
  kind: "FACTORY_LOG_FILTER";
  factory: Factory;
  fromBlock: number;
  toBlock: number;
};

type BlockTask = {
  kind: "BLOCK";
  blockNumber: number;
  callbacks: ((
    block: RpcBlock & { transactions: RpcTransaction[] }
  ) => Promise<void>)[];
};

type HistoricalSyncTask =
  | LogFilterTask
  | FactoryChildAddressTask
  | FactoryLogFilterTask
  | BlockTask;

export class HistoricalSyncService extends Emittery<HistoricalSyncEvents> {
  private common: Common;
  private eventStore: EventStore;
  private network: Network;

  /**
   * Service configuration. Will eventually be reloadable.
   */
  private finalizedBlockNumber: number = null!;
  private sources: Source[];

  /**
   * Block progress trackers for each task type.
   */
  private logFilterProgressTrackers: Record<string, ProgressTracker> = {};
  private factoryChildAddressProgressTrackers: Record<string, ProgressTracker> =
    {};
  private factoryLogFilterProgressTrackers: Record<string, ProgressTracker> =
    {};
  private blockProgressTracker: BlockProgressTracker =
    new BlockProgressTracker();

  /**
   * Functions registered by log filter + child contract tasks. These functions accept
   * a raw block object, get required data from it, then insert data and cache metadata
   * into the event store. The keys of this object are used to keep track of which blocks
   * must be fetched.
   */
  private blockCallbacks: Record<
    number,
    ((block: RpcBlock & { transactions: RpcTransaction[] }) => Promise<void>)[]
  > = {};

  /**
   * Block tasks have been added to the queue up to and including this block number.
   * Used alongside blockCallbacks to keep track of which block tasks to add to the queue.
   */
  private blockTasksEnqueuedCheckpoint = 0;

  private queue: Queue<HistoricalSyncTask>;
  private startTimestamp?: [number, number];
  private killFunctions: (() => void | Promise<void>)[] = [];

  constructor({
    common,
    eventStore,
    network,
    sources = [],
  }: {
    common: Common;
    eventStore: EventStore;
    network: Network;
    sources?: Source[];
  }) {
    super();

    this.common = common;
    this.eventStore = eventStore;
    this.network = network;
    this.sources = sources;

    this.queue = this.buildQueue();

    this.registerMetricCollectMethods();
  }

  async setup({
    latestBlockNumber,
    finalizedBlockNumber,
  }: {
    latestBlockNumber: number;
    finalizedBlockNumber: number;
  }) {
    this.finalizedBlockNumber = finalizedBlockNumber;

    await Promise.all([
      ...this.logFilters.map(async (logFilter) => {
        const { isHistoricalSyncRequired, startBlock, endBlock } =
          validateHistoricalBlockRange({
            startBlock: logFilter.startBlock,
            endBlock: logFilter.endBlock,
            finalizedBlockNumber,
            latestBlockNumber,
          });

        if (!isHistoricalSyncRequired) {
          this.logFilterProgressTrackers[logFilter.name] = new ProgressTracker({
            target: [startBlock, finalizedBlockNumber],
            completed: [[startBlock, finalizedBlockNumber]],
          });
          this.common.metrics.ponder_historical_total_blocks.set(
            { network: this.network.name, eventSource: logFilter.name },
            0
          );
          this.common.logger.warn({
            service: "historical",
            msg: `Start block is in unfinalized range, skipping historical sync (eventSource=${logFilter.name})`,
          });
          return;
        }

        const completedLogFilterIntervals =
          await this.eventStore.getLogFilterIntervals({
            chainId: logFilter.chainId,
            logFilter: {
              address: logFilter.criteria.address,
              topics: logFilter.criteria.topics,
            },
          });
        const logFilterProgressTracker = new ProgressTracker({
          target: [startBlock, endBlock],
          completed: completedLogFilterIntervals,
        });
        this.logFilterProgressTrackers[logFilter.name] =
          logFilterProgressTracker;

        const requiredLogFilterIntervals =
          logFilterProgressTracker.getRequired();

        const logFilterTaskChunks = getChunks({
          intervals: requiredLogFilterIntervals,
          maxChunkSize:
            logFilter.maxBlockRange ?? this.network.defaultMaxBlockRange,
        });

        for (const [fromBlock, toBlock] of logFilterTaskChunks) {
          this.queue.addTask(
            { kind: "LOG_FILTER", logFilter, fromBlock, toBlock },
            { priority: Number.MAX_SAFE_INTEGER - fromBlock }
          );
        }
        if (logFilterTaskChunks.length > 0) {
          const total = intervalSum(requiredLogFilterIntervals);
          this.common.logger.debug({
            service: "historical",
            msg: `Added LOG_FILTER tasks for ${total}-block range (logFilter=${logFilter.name}, network=${this.network.name})`,
          });
        }

        const targetBlockCount = endBlock - startBlock + 1;
        const cachedBlockCount = intervalSum(completedLogFilterIntervals);

        this.common.metrics.ponder_historical_total_blocks.set(
          { network: this.network.name, eventSource: logFilter.name },
          targetBlockCount
        );
        this.common.metrics.ponder_historical_cached_blocks.set(
          { network: this.network.name, eventSource: logFilter.name },
          cachedBlockCount
        );

        this.common.logger.info({
          service: "historical",
          msg: `Started sync with ${formatPercentage(
            Math.min(1, cachedBlockCount / (targetBlockCount || 1))
          )} cached (eventSource=${logFilter.name} network=${
            this.network.name
          })`,
        });
      }),
      ...this.factories.map(async (factory) => {
        const { isHistoricalSyncRequired, startBlock, endBlock } =
          validateHistoricalBlockRange({
            startBlock: factory.startBlock,
            endBlock: factory.endBlock,
            finalizedBlockNumber,
            latestBlockNumber,
          });

        if (!isHistoricalSyncRequired) {
          this.factoryChildAddressProgressTrackers[factory.name] =
            new ProgressTracker({
              target: [startBlock, finalizedBlockNumber],
              completed: [[startBlock, finalizedBlockNumber]],
            });
          this.factoryLogFilterProgressTrackers[factory.name] =
            new ProgressTracker({
              target: [startBlock, finalizedBlockNumber],
              completed: [[startBlock, finalizedBlockNumber]],
            });
          this.common.metrics.ponder_historical_total_blocks.set(
            { network: this.network.name, eventSource: factory.name },
            0
          );
          this.common.logger.warn({
            service: "historical",
            msg: `Start block is in unfinalized range, skipping historical sync (eventSource=${factory.name})`,
          });
          return;
        }

        // Note that factory child address progress is stored using
        // log intervals for the factory log.
        const completedFactoryChildAddressIntervals =
          await this.eventStore.getLogFilterIntervals({
            chainId: factory.chainId,
            logFilter: {
              address: factory.criteria.address,
              topics: [factory.criteria.eventSelector],
            },
          });
        const factoryChildAddressProgressTracker = new ProgressTracker({
          target: [startBlock, endBlock],
          completed: completedFactoryChildAddressIntervals,
        });
        this.factoryChildAddressProgressTrackers[factory.name] =
          factoryChildAddressProgressTracker;

        const requiredFactoryChildAddressIntervals =
          factoryChildAddressProgressTracker.getRequired();
        const factoryChildAddressTaskChunks = getChunks({
          intervals: requiredFactoryChildAddressIntervals,
          maxChunkSize:
            factory.maxBlockRange ?? this.network.defaultMaxBlockRange,
        });

        for (const [fromBlock, toBlock] of factoryChildAddressTaskChunks) {
          this.queue.addTask(
            { kind: "FACTORY_CHILD_ADDRESS", factory, fromBlock, toBlock },
            { priority: Number.MAX_SAFE_INTEGER - fromBlock }
          );
        }
        if (factoryChildAddressTaskChunks.length > 0) {
          const total = intervalSum(requiredFactoryChildAddressIntervals);
          this.common.logger.debug({
            service: "historical",
            msg: `Added FACTORY_CHILD_ADDRESS tasks for ${total}-block range (factory=${factory.name}, network=${this.network.name})`,
          });
        }

        const targetFactoryChildAddressBlockCount = endBlock - startBlock + 1;
        const cachedFactoryChildAddressBlockCount = intervalSum(
          completedFactoryChildAddressIntervals
        );

        this.common.metrics.ponder_historical_total_blocks.set(
          {
            network: this.network.name,
            eventSource: `${factory.name}_factory`,
          },
          targetFactoryChildAddressBlockCount
        );
        this.common.metrics.ponder_historical_cached_blocks.set(
          {
            network: this.network.name,
            eventSource: `${factory.name}_factory`,
          },
          cachedFactoryChildAddressBlockCount
        );

        const completedFactoryLogFilterIntervals =
          await this.eventStore.getFactoryLogFilterIntervals({
            chainId: factory.chainId,
            factory: factory.criteria,
          });
        const factoryLogFilterProgressTracker = new ProgressTracker({
          target: [startBlock, endBlock],
          completed: completedFactoryLogFilterIntervals,
        });
        this.factoryLogFilterProgressTrackers[factory.name] =
          factoryLogFilterProgressTracker;

        // Manually add factory log filter tasks for any intervals where the
        // child address tasks are completed, but the child log filter tasks are not,
        // because these won't be added automatically by the factory child address tasks.
        const requiredFactoryLogFilterIntervals =
          factoryLogFilterProgressTracker.getRequired();
        const missingFactoryLogFilterIntervals = intervalDifference(
          requiredFactoryLogFilterIntervals,
          requiredFactoryChildAddressIntervals
        );

        const missingFactoryLogFilterTaskChunks = getChunks({
          intervals: missingFactoryLogFilterIntervals,
          maxChunkSize:
            factory.maxBlockRange ?? this.network.defaultMaxBlockRange,
        });

        for (const [fromBlock, toBlock] of missingFactoryLogFilterTaskChunks) {
          this.queue.addTask(
            { kind: "FACTORY_LOG_FILTER", factory, fromBlock, toBlock },
            { priority: Number.MAX_SAFE_INTEGER - fromBlock }
          );
        }
        if (missingFactoryLogFilterTaskChunks.length > 0) {
          const total = intervalSum(missingFactoryLogFilterIntervals);
          this.common.logger.debug({
            service: "historical",
            msg: `Added FACTORY_LOG_FILTER tasks for ${total}-block range (factory=${factory.name}, network=${this.network.name})`,
          });
        }

        const targetFactoryLogFilterBlockCount = endBlock - startBlock + 1;
        const cachedFactoryLogFilterBlockCount = intervalSum(
          completedFactoryLogFilterIntervals
        );

        this.common.metrics.ponder_historical_total_blocks.set(
          { network: this.network.name, eventSource: factory.name },
          targetFactoryLogFilterBlockCount
        );
        this.common.metrics.ponder_historical_cached_blocks.set(
          { network: this.network.name, eventSource: factory.name },
          cachedFactoryLogFilterBlockCount
        );

        // Use factory log filter progress for the logger because it better represents
        // user-facing progress.
        const cacheRate = Math.min(
          1,
          cachedFactoryLogFilterBlockCount /
            (targetFactoryLogFilterBlockCount || 1)
        );
        this.common.logger.info({
          service: "historical",
          msg: `Started sync with ${formatPercentage(
            cacheRate
          )} cached (eventSource=${factory.name} network=${this.network.name})`,
        });
      }),
    ]);
  }

  start() {
    this.startTimestamp = process.hrtime();

    // Emit status update logs on an interval for each active log filter.
    const updateLogInterval = setInterval(async () => {
      const completionStats = await this.getCompletionStats();

      completionStats.forEach(({ eventSource, rate, eta }) => {
        if (rate === 1) return;
        this.common.logger.info({
          service: "historical",
          msg: `Sync is ${formatPercentage(rate)} complete${
            eta !== undefined ? ` with ~${formatEta(eta)} remaining` : ""
          } (eventSource=${eventSource})`,
          network: this.network.name,
        });
      });
    }, 10_000);

    this.killFunctions.push(() => {
      clearInterval(updateLogInterval);
    });

    // Edge case: If there are no tasks in the queue, this means the entire
    // requested range was cached, so the sync is complete. However, we still
    // need to emit the historicalCheckpoint event with some timestamp. It should
    // be safe to use the current timestamp.
    if (this.queue.size === 0) {
      this.emit("historicalCheckpoint", {
        blockNumber: this.finalizedBlockNumber,
        blockTimestamp: Math.round(Date.now() / 1000),
      });
      this.emit("syncComplete");
      this.common.logger.info({
        service: "historical",
        msg: `Completed sync (network=${this.network.name})`,
        network: this.network.name,
      });
    }

    this.queue.start();
  }

  kill = async () => {
    for (const fn of this.killFunctions) {
      await fn();
    }

    this.queue.pause();
    this.queue.clear();
    // TODO: Figure out if it's necessary to wait for the queue to be idle before killing it.
    // await this.onIdle();
    this.common.logger.debug({
      service: "historical",
      msg: `Killed historical sync service (network=${this.network.name})`,
    });
  };

  onIdle = async () => {
    await this.queue.onIdle();
  };

  private buildQueue = () => {
    const worker: Worker<HistoricalSyncTask> = async ({ task, queue }) => {
      switch (task.kind) {
        case "LOG_FILTER": {
          await this.logFilterTaskWorker({ task });
          break;
        }
        case "FACTORY_CHILD_ADDRESS": {
          await this.factoryChildAddressTaskWorker({ task });
          break;
        }
        case "FACTORY_LOG_FILTER": {
          await this.factoryLogFilterTaskWorker({ task });
          break;
        }
        case "BLOCK": {
          await this.blockTaskWorker({ task });
          break;
        }
      }

      // If this is not the final task, return.
      if (queue.size > 0 || queue.pending > 1) return;

      // If this is the final task, run the cleanup/completion logic.
      this.emit("syncComplete");
      const duration = hrTimeToMs(process.hrtime(this.startTimestamp));
      this.common.logger.info({
        service: "historical",
        msg: `Completed sync in ${formatEta(duration)} (network=${
          this.network.name
        })`,
      });
    };

    const queue = createQueue<HistoricalSyncTask>({
      worker,
      options: {
        concurrency: this.network.maxRpcRequestConcurrency,
        autoStart: false,
      },
      onError: ({ error, task, queue }) => {
        switch (task.kind) {
          case "LOG_FILTER": {
            this.common.logger.error({
              service: "historical",
              msg: `Log filter task failed, retrying... [${task.fromBlock}, ${task.toBlock}] (logFilter=${task.logFilter.name}, network=${this.network.name})`,
              error,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask(task, { priority, retry: true });
            break;
          }
          case "FACTORY_CHILD_ADDRESS": {
            this.common.logger.error({
              service: "historical",
              msg: `Factory child address task failed, retrying... [${task.fromBlock}, ${task.toBlock}] (factory=${task.factory.name}, network=${this.network.name})`,
              error,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask(task, { priority, retry: true });
            break;
          }
          case "FACTORY_LOG_FILTER": {
            this.common.logger.error({
              service: "historical",
              msg: `Factory log filter task failed, retrying... [${task.fromBlock}, ${task.toBlock}] (factory=${task.factory.name}, network=${this.network.name})`,
              error,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask(task, { priority, retry: true });
            break;
          }
          case "BLOCK": {
            this.common.logger.error({
              service: "historical",
              msg: `Block task failed, retrying... [${task.blockNumber}] (network=${this.network.name})`,
              error,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.blockNumber;
            queue.addTask(task, { priority, retry: true });
            break;
          }
        }
      },
    });

    return queue;
  };

  private logFilterTaskWorker = async ({ task }: { task: LogFilterTask }) => {
    const { logFilter, fromBlock, toBlock } = task;

    const logs = await this._eth_getLogs({
      address: logFilter.criteria.address,
      topics: logFilter.criteria.topics,
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
    });

    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });

    for (const logInterval of logIntervals) {
      const { startBlock, endBlock, logs, transactionHashes } = logInterval;
      (this.blockCallbacks[endBlock] ||= []).push(async (block) => {
        await this.eventStore.insertLogFilterInterval({
          chainId: logFilter.chainId,
          block,
          transactions: block.transactions.filter((tx) =>
            transactionHashes.has(tx.hash)
          ),
          logs,
          logFilter: logFilter.criteria,
          interval: {
            startBlock: BigInt(startBlock),
            endBlock: BigInt(endBlock),
          },
        });
        this.common.metrics.ponder_historical_completed_blocks.inc(
          { network: this.network.name, eventSource: logFilter.name },
          endBlock - startBlock + 1
        );
      });
    }

    this.logFilterProgressTrackers[task.logFilter.name].addCompletedInterval([
      task.fromBlock,
      task.toBlock,
    ]);

    this.enqueueBlockTasks();

    this.common.logger.trace({
      service: "historical",
      msg: `Completed LOG_FILTER task [${task.fromBlock}, ${task.toBlock}] (logFilter=${task.logFilter.name}, network=${this.network.name})`,
    });
  };

  private factoryChildAddressTaskWorker = async ({
    task,
  }: {
    task: FactoryChildAddressTask;
  }) => {
    const { factory, fromBlock, toBlock } = task;

    const logs = await this._eth_getLogs({
      address: factory.criteria.address,
      topics: [factory.criteria.eventSelector],
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
    });

    // Insert the new child address logs into the store.
    await this.eventStore.insertFactoryChildAddressLogs({
      chainId: factory.chainId,
      logs,
    });

    // Register block callbacks for the child address logs. This is how
    // the intervals will be recorded (marking the child address logs as
    // cached on subsequent starts).
    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });
    for (const logInterval of logIntervals) {
      const { startBlock, endBlock, logs, transactionHashes } = logInterval;
      (this.blockCallbacks[endBlock] ||= []).push(async (block) => {
        await this.eventStore.insertLogFilterInterval({
          chainId: factory.chainId,
          logFilter: {
            address: factory.criteria.address,
            topics: [factory.criteria.eventSelector],
          },
          block,
          transactions: block.transactions.filter((tx) =>
            transactionHashes.has(tx.hash)
          ),
          logs,
          interval: {
            startBlock: BigInt(startBlock),
            endBlock: BigInt(endBlock),
          },
        });
      });
    }

    // Update the checkpoint, and if necessary, enqueue factory log filter tasks.
    const { isUpdated, prevCheckpoint, newCheckpoint } =
      this.factoryChildAddressProgressTrackers[
        factory.name
      ].addCompletedInterval([fromBlock, toBlock]);
    if (isUpdated) {
      const factoryLogFilterChunks = getChunks({
        intervals: [[prevCheckpoint + 1, newCheckpoint]],
        maxChunkSize:
          factory.maxBlockRange ?? this.network.defaultMaxBlockRange,
      });

      for (const [fromBlock, toBlock] of factoryLogFilterChunks) {
        this.queue.addTask(
          { kind: "FACTORY_LOG_FILTER", factory, fromBlock, toBlock },
          { priority: Number.MAX_SAFE_INTEGER - fromBlock }
        );
      }
    }
    this.common.metrics.ponder_historical_completed_blocks.inc(
      { network: this.network.name, eventSource: `${factory.name}_factory` },
      toBlock - fromBlock + 1
    );

    this.common.logger.trace({
      service: "historical",
      msg: `Completed FACTORY_CHILD_ADDRESS task [${task.fromBlock}, ${task.toBlock}] (factory=${task.factory.name}, network=${this.network.name})`,
    });
  };

  private factoryLogFilterTaskWorker = async ({
    task: { factory, fromBlock, toBlock },
  }: {
    task: FactoryLogFilterTask;
  }) => {
    const iterator = this.eventStore.getFactoryChildAddresses({
      chainId: factory.chainId,
      factory: factory.criteria,
      upToBlockNumber: BigInt(toBlock),
    });

    const logs: RpcLog[] = [];

    for await (const childContractAddressBatch of iterator) {
      const batchLogs = await this._eth_getLogs({
        address: childContractAddressBatch,
        topics: factory.criteria.topics,
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
      });
      logs.push(...batchLogs);
    }

    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });

    for (const logInterval of logIntervals) {
      const { startBlock, endBlock, logs, transactionHashes } = logInterval;

      (this.blockCallbacks[endBlock] ||= []).push(async (block) => {
        await this.eventStore.insertFactoryLogFilterInterval({
          chainId: factory.chainId,
          factory: factory.criteria,
          block,
          transactions: block.transactions.filter((tx) =>
            transactionHashes.has(tx.hash)
          ),
          logs,
          interval: {
            startBlock: BigInt(startBlock),
            endBlock: BigInt(endBlock),
          },
        });

        this.common.metrics.ponder_historical_completed_blocks.inc(
          { network: this.network.name, eventSource: factory.name },
          endBlock - startBlock + 1
        );
      });
    }

    this.factoryLogFilterProgressTrackers[factory.name].addCompletedInterval([
      fromBlock,
      toBlock,
    ]);

    this.enqueueBlockTasks();

    this.common.logger.trace({
      service: "historical",
      msg: `Completed FACTORY_LOG_FILTER task [${fromBlock}, ${toBlock}] (factory=${factory.name}, network=${this.network.name})`,
    });
  };

  private blockTaskWorker = async ({ task }: { task: BlockTask }) => {
    const { blockNumber, callbacks } = task;

    const stopClock = startClock();
    const block = (await this.network.client.request({
      method: "eth_getBlockByNumber",
      params: [toHex(blockNumber), true],
    })) as RpcBlock & { transactions: RpcTransaction[] };
    this.common.metrics.ponder_historical_rpc_request_duration.observe(
      { method: "eth_getBlockByNumber", network: this.network.name },
      stopClock()
    );

    if (!block) throw new Error(`Block not found: ${blockNumber}`);

    await Promise.all(callbacks.map((cb) => cb(block)));

    const newBlockCheckpoint = this.blockProgressTracker.addCompletedBlock({
      blockNumber,
      blockTimestamp: hexToNumber(block.timestamp),
    });

    if (newBlockCheckpoint) {
      this.emit("historicalCheckpoint", newBlockCheckpoint);
    }

    this.common.logger.trace({
      service: "historical",
      msg: `Completed BLOCK task ${hexToNumber(block.number!)} with ${
        callbacks.length
      } callbacks (network=${this.network.name})`,
    });
  };

  private buildLogIntervals = ({
    fromBlock,
    toBlock,
    logs,
  }: {
    fromBlock: number;
    toBlock: number;
    logs: RpcLog[];
  }) => {
    const logsByBlockNumber: Record<number, RpcLog[] | undefined> = {};
    const txHashesByBlockNumber: Record<number, Set<Hash> | undefined> = {};

    logs.forEach((log) => {
      const blockNumber = hexToNumber(log.blockNumber!);
      (txHashesByBlockNumber[blockNumber] ||= new Set<Hash>()).add(
        log.transactionHash!
      );
      (logsByBlockNumber[blockNumber] ||= []).push(log);
    });

    const requiredBlocks = Object.keys(txHashesByBlockNumber)
      .map(Number)
      .sort((a, b) => a - b);

    // If toBlock is not already required, add it. This is necessary
    // to mark the full block range of the eth_getLogs request as cached.
    if (!requiredBlocks.includes(toBlock)) {
      requiredBlocks.push(toBlock);
    }

    const requiredIntervals: {
      startBlock: number;
      endBlock: number;
      logs: RpcLog[];
      transactionHashes: Set<Hash>;
    }[] = [];

    let prev = fromBlock;
    for (const blockNumber of requiredBlocks) {
      requiredIntervals.push({
        startBlock: prev,
        endBlock: blockNumber,
        logs: logsByBlockNumber[blockNumber] ?? [],
        transactionHashes: txHashesByBlockNumber[blockNumber] ?? new Set(),
      });
      prev = blockNumber + 1;
    }

    return requiredIntervals;
  };

  private enqueueBlockTasks = () => {
    const blockTasksCanBeEnqueuedTo = Math.min(
      ...Object.values(this.logFilterProgressTrackers).map((i) =>
        i.getCheckpoint()
      ),
      ...Object.values(this.factoryChildAddressProgressTrackers).map((i) =>
        i.getCheckpoint()
      ),
      ...Object.values(this.factoryLogFilterProgressTrackers).map((i) =>
        i.getCheckpoint()
      )
    );

    if (blockTasksCanBeEnqueuedTo > this.blockTasksEnqueuedCheckpoint) {
      const newBlocks = Object.keys(this.blockCallbacks)
        .map(Number)
        .filter((blockNumber) => blockNumber <= blockTasksCanBeEnqueuedTo);

      this.blockProgressTracker.addPendingBlocks({ blockNumbers: newBlocks });

      for (const blockNumber of newBlocks) {
        this.queue.addTask(
          {
            kind: "BLOCK",
            blockNumber,
            callbacks: this.blockCallbacks[blockNumber],
          },
          { priority: Number.MAX_SAFE_INTEGER - blockNumber }
        );
        delete this.blockCallbacks[blockNumber];
      }

      this.blockTasksEnqueuedCheckpoint = blockTasksCanBeEnqueuedTo;
    }
  };

  private _eth_getLogs = async (
    options: LogFilterCriteria & { fromBlock: Hex; toBlock: Hex }
  ) => {
    const logs: RpcLog[] = [];

    let error: Error | null = null;

    const stopClock = startClock();
    try {
      const logs_ = await this.network.client.request({
        method: "eth_getLogs",
        params: [options],
      });
      logs.push(...logs_);
    } catch (err) {
      error = err as Error;
    } finally {
      this.common.metrics.ponder_historical_rpc_request_duration.observe(
        { method: "eth_getLogs", network: this.network.name },
        stopClock()
      );
    }

    if (!error) return logs;

    const retryRanges: [Hex, Hex][] = [];
    if (
      // Alchemy response size error.
      error instanceof InvalidParamsRpcError &&
      error.details.startsWith("Log response size exceeded.")
    ) {
      const safe = error.details.split("this block range should work: ")[1];
      const safeStart = Number(safe.split(", ")[0].slice(1));
      const safeEnd = Number(safe.split(", ")[1].slice(0, -1));

      retryRanges.push([toHex(safeStart), toHex(safeEnd)]);
      retryRanges.push([toHex(safeEnd + 1), options.toBlock]);
    } else if (
      // Infura block range limit error.
      error instanceof LimitExceededRpcError &&
      error.details.includes("query returned more than 10000 results")
    ) {
      const safe = error.details.split("Try with this block range ")[1];
      const safeStart = Number(safe.split(", ")[0].slice(1));
      const safeEnd = Number(safe.split(", ")[1].slice(0, -2));

      retryRanges.push([toHex(safeStart), toHex(safeEnd)]);
      retryRanges.push([toHex(safeEnd + 1), options.toBlock]);
    } else if (
      // Thirdweb block range limit error.
      error instanceof InvalidParamsRpcError &&
      error.details.includes("block range less than 20000")
    ) {
      const midpoint = Math.floor(
        (Number(options.toBlock) - Number(options.fromBlock)) / 2 +
          Number(options.fromBlock)
      );

      retryRanges.push([toHex(options.fromBlock), toHex(midpoint)]);
      retryRanges.push([toHex(midpoint + 1), options.toBlock]);
    } else if (
      // Handle Quicknode block range limit error (should never happen).
      error instanceof HttpRequestError &&
      error.details.includes(
        "eth_getLogs and eth_newFilter are limited to a 10,000 blocks range"
      )
    ) {
      const midpoint = Math.floor(
        (Number(options.toBlock) - Number(options.fromBlock)) / 2 +
          Number(options.fromBlock)
      );
      retryRanges.push([toHex(options.fromBlock), toHex(midpoint)]);
      retryRanges.push([toHex(midpoint + 1), options.toBlock]);
    } else {
      // Throw any unrecognized errors.
      throw error;
    }

    for (const [from, to] of retryRanges) {
      const logs_ = await this._eth_getLogs({
        ...options,
        fromBlock: from,
        toBlock: to,
      });
      logs.push(...logs_);
    }

    return logs;
  };

  private getCompletionStats = async () => {
    const cachedBlocksMetric = (
      await this.common.metrics.ponder_historical_cached_blocks.get()
    ).values;
    const totalBlocksMetric = (
      await this.common.metrics.ponder_historical_total_blocks.get()
    ).values;
    const completedBlocksMetric = (
      await this.common.metrics.ponder_historical_completed_blocks.get()
    ).values;

    const eventSourceNames = this.sources.map((s) => s.name);

    return eventSourceNames.map((name) => {
      const totalBlocks = totalBlocksMetric.find(
        (m) => m.labels.eventSource === name
      )?.value;
      const cachedBlocks = cachedBlocksMetric.find(
        (m) => m.labels.eventSource === name
      )?.value;
      const completedBlocks =
        completedBlocksMetric.find((m) => m.labels.eventSource === name)
          ?.value ?? 0;

      // If the total_blocks metric is set and equals zero, the sync was skipped and
      // should be considered complete.
      if (totalBlocks === 0) {
        return { eventSource: name, rate: 1, eta: 0 };
      }

      // Any of these mean setup is not complete.
      if (
        totalBlocks === undefined ||
        cachedBlocks === undefined ||
        !this.startTimestamp
      ) {
        return { eventSource: name, rate: 0 };
      }

      const rate = (cachedBlocks + completedBlocks) / totalBlocks;

      // If fewer than 3 blocks have been processsed, the ETA will be low quality.
      if (completedBlocks < 3) return { eventSource: name, rate };

      // If rate is 1, sync is complete, so set the ETA to zero.
      if (rate === 1) return { eventSource: name, rate, eta: 0 };

      // (time elapsed) / (% completion of remaining block range)
      const elapsed = hrTimeToMs(process.hrtime(this.startTimestamp));
      const estimatedTotalDuration =
        elapsed / (completedBlocks / (totalBlocks - cachedBlocks));
      const estimatedTimeRemaining = estimatedTotalDuration - elapsed;

      return { eventSource: name, rate, eta: estimatedTimeRemaining };
    });
  };

  private registerMetricCollectMethods = async () => {
    // The `prom-client` base Metric class does allow dynamic assignment
    // of the `collect()` method, but it's not typed as such.

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.common.metrics.ponder_historical_completion_rate.collect =
      async () => {
        const completionStats = await this.getCompletionStats();
        completionStats.forEach(({ eventSource, rate }) => {
          this.common.metrics.ponder_historical_completion_rate.set(
            { eventSource, network: this.network.name },
            rate
          );
        });
      };

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.common.metrics.ponder_historical_completion_eta.collect = async () => {
      const completionStats = await this.getCompletionStats();
      completionStats.forEach(({ eventSource, eta }) => {
        // If no progress has been made, can't calculate an accurate ETA.
        if (eta) {
          this.common.metrics.ponder_historical_completion_eta.set(
            { eventSource, network: this.network.name },
            eta
          );
        }
      });
    };
  };
}
