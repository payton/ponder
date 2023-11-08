import path from "node:path";
import process from "node:process";

import { BuildService } from "@/build/service";
import { CodegenService } from "@/codegen/service";
import { buildDatabase } from "@/config/database";
import { type Network, buildNetwork } from "@/config/networks";
import { type Options } from "@/config/options";
import { UserErrorService } from "@/errors/service";
import { IndexingService } from "@/indexing/service";
import { PostgresIndexingStore } from "@/indexing-store/postgres/store";
import { SqliteIndexingStore } from "@/indexing-store/sqlite/store";
import { type IndexingStore } from "@/indexing-store/store";
import { LoggerService } from "@/logs/service";
import { MetricsService } from "@/metrics/service";
import { ServerService } from "@/server/service";
import { SyncGateway } from "@/sync-gateway/service";
import { HistoricalSyncService } from "@/sync-historical/service";
import { RealtimeSyncService } from "@/sync-realtime/service";
import { PostgresSyncStore } from "@/sync-store/postgres/store";
import { SqliteSyncStore } from "@/sync-store/sqlite/store";
import { type SyncStore } from "@/sync-store/store";
import { TelemetryService } from "@/telemetry/service";
import { UiService } from "@/ui/service";

import { hydrateIndexingFunctions } from "./build/functions";
import { buildSources, Source } from "./config/sources";

export type Common = {
  options: Options;
  logger: LoggerService;
  errors: UserErrorService;
  metrics: MetricsService;
  telemetry: TelemetryService;
};

export class Ponder {
  common: Common;
  buildService: BuildService;

  // Derived config
  sources: Source[] = undefined!;

  // Sync services
  syncStore: SyncStore = undefined!;
  syncServices: {
    network: Network;
    sources: Source[];
    historical: HistoricalSyncService;
    realtime: RealtimeSyncService;
  }[] = undefined!;
  syncGatewayService: SyncGateway = undefined!;

  // Indexing services
  indexingStore: IndexingStore = undefined!;
  indexingService: IndexingService = undefined!;

  // Misc services
  serverService: ServerService = undefined!;
  codegenService: CodegenService = undefined!;
  uiService: UiService = undefined!;

  constructor({ options }: { options: Options }) {
    const logger = new LoggerService({
      level: options.logLevel,
      dir: options.logDir,
    });
    const errors = new UserErrorService();
    const metrics = new MetricsService();
    const telemetry = new TelemetryService({ options });

    this.common = { options, logger, errors, metrics, telemetry };

    this.buildService = new BuildService({ common: this.common });
  }

  async setup({
    syncStore,
    indexingStore,
  }: {
    // These options are only used for testing.
    syncStore?: SyncStore;
    indexingStore?: IndexingStore;
  } = {}) {
    this.common.logger.debug({
      service: "app",
      msg: `Started using config file: ${path.relative(
        this.common.options.rootDir,
        this.common.options.configFile
      )}`,
    });

    // Initialize the Vite server and Vite Node runner.
    await this.buildService.setup();

    // Load the config file so that we can create initial versions of all services.
    // If `config` is undefined, there was an error loading the config. For now,
    // we can just exit. No need to call `this.kill()` because no services are set up.
    const config = await this.buildService.loadConfig();
    if (!config) {
      await this.buildService.kill();
      return;
    }

    const database = buildDatabase({ common: this.common, config });
    this.syncStore =
      syncStore ??
      (database.kind === "sqlite"
        ? new SqliteSyncStore({ db: database.db })
        : new PostgresSyncStore({ pool: database.pool }));

    this.indexingStore =
      indexingStore ??
      (database.kind === "sqlite"
        ? new SqliteIndexingStore({ db: database.db })
        : new PostgresIndexingStore({ pool: database.pool }));

    this.sources = buildSources({ config });

    const networksToSync = config.networks
      .map((network) => buildNetwork({ network, common: this.common }))
      .filter((network) => {
        const hasEventSources = this.sources.some(
          (eventSource) => eventSource.network === network.name
        );
        if (!hasEventSources) {
          this.common.logger.warn({
            service: "app",
            msg: `No contracts found (network=${network.name})`,
          });
        }
        return hasEventSources;
      });

    this.syncServices = [];
    networksToSync.forEach((network) => {
      const sourcesForNetwork = this.sources.filter(
        (logSource) => logSource.network === network.name
      );
      this.syncServices.push({
        network,
        sources: sourcesForNetwork,
        historical: new HistoricalSyncService({
          common: this.common,
          syncStore: this.syncStore,
          network,
          sources: sourcesForNetwork,
        }),
        realtime: new RealtimeSyncService({
          common: this.common,
          syncStore: this.syncStore,
          network,
          sources: sourcesForNetwork,
        }),
      });
    });
    this.syncGatewayService = new SyncGateway({
      common: this.common,
      syncStore: this.syncStore,
      networks: networksToSync,
      sources: this.sources,
    });

    this.indexingService = new IndexingService({
      common: this.common,
      syncStore: this.syncStore,
      indexingStore: this.indexingStore,
      syncGatewayService: this.syncGatewayService,
      sources: this.sources,
    });

    this.serverService = new ServerService({
      common: this.common,
      indexingStore: this.indexingStore,
    });
    this.codegenService = new CodegenService({
      common: this.common,
      sources: this.sources,
    });
    this.uiService = new UiService({
      common: this.common,
      sources: this.sources,
    });

    // Once all services have been successfully created & started
    // using the initial config, register service dependencies.
    this.registerServiceDependencies();

    // TODO: Remove once we have the new PonderApp magic.
    this.codegenService.generateAppFile();

    // One-time setup for some services.
    await this.syncStore.migrateUp();
    await this.serverService.start();

    // Finally, load the schema + indexing functions which will trigger
    // the indexing service to reload (for the first time).
    await this.buildService.loadIndexingFunctions();
    await this.buildService.loadSchema();
  }

  async dev() {
    this.common.telemetry.record({
      event: "App Started",
      properties: {
        command: "ponder dev",
        contractCount: this.sources.length,
        databaseKind: this.syncStore.kind,
      },
    });

    await Promise.all(
      this.syncServices.map(async ({ historical, realtime }) => {
        const blockNumbers = await realtime.setup();
        await historical.setup(blockNumbers);

        historical.start();
        await realtime.start();
      })
    );
  }

  async start() {
    this.common.telemetry.record({
      event: "App Started",
      properties: {
        command: "ponder start",
        contractCount: this.sources.length,
        databaseKind: this.syncStore.kind,
      },
    });

    await Promise.all(
      this.syncServices.map(async ({ historical, realtime }) => {
        const blockNumbers = await realtime.setup();
        await historical.setup(blockNumbers);

        historical.start();
        await realtime.start();
      })
    );
  }

  async codegen() {
    this.codegenService.generateAppFile();

    const result = await this.buildService.loadSchema();
    if (result) {
      const { graphqlSchema } = result;
      this.codegenService.generateGraphqlSchemaFile({ graphqlSchema });
    }

    await this.kill();
  }

  async kill() {
    this.syncGatewayService.clearListeners();

    this.common.telemetry.record({
      event: "App Killed",
      properties: {
        processDuration: process.uptime(),
      },
    });

    await Promise.all(
      this.syncServices.map(async ({ realtime, historical }) => {
        await realtime.kill();
        await historical.kill();
      })
    );

    await this.buildService.kill();
    this.uiService.kill();
    this.indexingService.kill();
    await this.serverService.kill();
    await this.common.telemetry.kill();

    await this.indexingStore.kill();
    await this.syncStore.kill();

    this.common.logger.debug({
      service: "app",
      msg: `Finished shutdown sequence`,
    });
  }

  private registerServiceDependencies() {
    this.buildService.on("newConfig", async () => {
      this.common.logger.fatal({
        service: "build",
        msg: "Detected change in ponder.config.ts",
      });
      await this.kill();
    });

    this.buildService.on("newSchema", async ({ schema, graphqlSchema }) => {
      this.common.errors.hasUserError = false;

      this.codegenService.generateAppFile({ schema });
      this.codegenService.generateGraphqlSchemaFile({ graphqlSchema });

      this.serverService.reload({ graphqlSchema });

      await this.indexingService.reset({ schema });
      await this.indexingService.processEvents();
    });

    this.buildService.on(
      "newIndexingFunctions",
      async ({ indexingFunctions }) => {
        this.common.errors.hasUserError = false;

        // This is jank. Not quite sure where this should go.
        const hydrated = hydrateIndexingFunctions({
          rawIndexingFunctions: indexingFunctions,
          sources: this.sources,
        });
        await this.indexingService.reset({ indexingFunctions: hydrated });

        await this.indexingService.processEvents();
      }
    );

    this.syncServices.forEach(({ network, historical, realtime }) => {
      const { chainId } = network;

      historical.on("historicalCheckpoint", ({ blockTimestamp }) => {
        this.syncGatewayService.handleNewHistoricalCheckpoint({
          chainId,
          timestamp: blockTimestamp,
        });
      });

      historical.on("syncComplete", () => {
        this.syncGatewayService.handleHistoricalSyncComplete({
          chainId,
        });
      });

      realtime.on("realtimeCheckpoint", ({ blockTimestamp }) => {
        this.syncGatewayService.handleNewRealtimeCheckpoint({
          chainId,
          timestamp: blockTimestamp,
        });
      });

      realtime.on("finalityCheckpoint", ({ blockTimestamp }) => {
        this.syncGatewayService.handleNewFinalityCheckpoint({
          chainId,
          timestamp: blockTimestamp,
        });
      });

      realtime.on("shallowReorg", ({ commonAncestorBlockTimestamp }) => {
        this.syncGatewayService.handleReorg({
          commonAncestorTimestamp: commonAncestorBlockTimestamp,
        });
      });
    });

    this.syncGatewayService.on("newCheckpoint", async () => {
      await this.indexingService.processEvents();
    });

    this.syncGatewayService.on("reorg", async ({ commonAncestorTimestamp }) => {
      await this.indexingService.handleReorg({ commonAncestorTimestamp });
      await this.indexingService.processEvents();
    });

    this.indexingService.on("eventsProcessed", ({ toTimestamp }) => {
      if (this.serverService.isHistoricalIndexingComplete) return;

      // If a batch of events are processed AND the historical sync is complete AND
      // the new toTimestamp is greater than the historical sync completion timestamp,
      // historical event processing is complete, and the server should begin responding as healthy.
      if (
        this.syncGatewayService.historicalSyncCompletedAt &&
        toTimestamp >= this.syncGatewayService.historicalSyncCompletedAt
      ) {
        this.serverService.setIsHistoricalIndexingComplete();
      }
    });
  }
}
