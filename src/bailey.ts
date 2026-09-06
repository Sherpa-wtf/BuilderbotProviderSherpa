import { ProviderClass, utils } from "@builderbot/bot";
import type {
  BotContext,
  Button,
  SendOptions,
} from "@builderbot/bot/dist/types";
import type { Boom } from "@hapi/boom";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { WABrowserDescription } from "baileys";
import { Console } from "console";
import { Writable } from "node:stream";
import type { PathOrFileDescriptor } from "fs";
import { createWriteStream, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import mime from "mime-types";
import NodeCache from "node-cache";
import { tmpdir } from "os";
import { join, basename, resolve } from "path";
import pino from "pino";
import type polka from "polka";
import type { IStickerOptions } from "wa-sticker-formatter";
import { Sticker } from "wa-sticker-formatter";

import {
  AnyMediaMessageContent,
  AnyMessageContent,
  BaileysEventMap,
  WAMessage,
  WASocket,
  MessageUpsertType,
  isJidGroup,
  isJidBroadcast,
  DisconnectReason,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  makeCacheableSignalKeyStore,
  makeWASocketOther,
  proto,
  useMultiFileAuthState,
} from "./baileyWrapper";
import { releaseTmp } from "./releaseTmp";
import { OfflineReplayWindow } from "./offlineReplay";
import { QrChallengeStore } from "./qrChallenge";
import qrImage from "qr-image";
import type { BaileyGlobalVendorArgs } from "./type";
import {
  baileyCleanNumber,
  baileyIsPossibleNumber,
  baileyIsValidNumber,
  emptyDirSessions,
} from "./utils";

export type BaileysMessageStatusStage =
  | "error"
  | "pending"
  | "server_ack"
  | "delivery_ack"
  | "read"
  | "played"
  | "unknown";

export interface BaileysMessageStatusEvent {
  provider: "baileys";
  providerMessageId: string;
  remoteJid?: string | null;
  fromMe?: boolean | null;
  status: number;
  stage: BaileysMessageStatusStage;
  observedAt: string;
  error?: Record<string, unknown>;
}

/**
 * `code` del error que tira el provider cuando se niega a enviar porque el
 * destino no puede recibir. Es contrato con el consumidor durable: significa
 * "esto NO salio a la red", que es lo unico que autoriza a marcarlo terminal en
 * vez de dejarlo como resultado desconocido.
 */
export const BAILEYS_DESTINATION_UNREACHABLE = "BAILEYS_DESTINATION_UNREACHABLE";

const BAILEYS_STATUS_STAGE: Record<number, BaileysMessageStatusStage> = {
  0: "error",
  1: "pending",
  2: "server_ack",
  3: "delivery_ack",
  4: "read",
  5: "played",
};

const boundedString = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 512) : undefined;
};

const statusErrorEvidence = (update: any): Record<string, unknown> | undefined => {
  const evidence: Record<string, unknown> = {};
  if (Array.isArray(update.messageStubParameters)) {
    const messageStubParameters = update.messageStubParameters
      .slice(0, 10)
      .map(boundedString)
      .filter(Boolean);
    if (messageStubParameters.length > 0) {
      evidence.messageStubParameters = messageStubParameters;
    }
  }
  const code = boundedString(update.error?.code ?? update.code);
  const name = boundedString(update.error?.name);
  const message = boundedString(update.error?.message ?? update.message);
  if (code) evidence.code = code;
  if (name) evidence.name = name;
  if (message) evidence.message = message;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
};

export interface ProviderLifecycleEvent {
  state: "connecting" | "ready" | "requires_link" | "disconnected" | "error";
  socketGeneration: number;
  observedAt: string;
  reasonCode?: number;
  phoneNumber?: string;
}

class BaileysProvider extends ProviderClass<WASocket> {
  private readonly qrInstanceId = randomUUID();
  private lifecycleStopped = false;
  private lifecycleSendWrapper: ((descriptor: unknown, network: () => Promise<any>) => Promise<any>) | null = null;
  public setLifecycleSendWrapper(wrapper: (descriptor: unknown, network: () => Promise<any>) => Promise<any>): void { this.lifecycleSendWrapper = wrapper; }
  private lifecycleIncomingGate: ((payload: any, dispatch: () => boolean) => Promise<boolean>) | null = null;
  public setLifecycleIncomingGate(gate: (payload: any, dispatch: () => boolean) => Promise<boolean>): void { this.lifecycleIncomingGate = gate; }
  private lifecycleGuard: (() => Promise<void>) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  public setLifecycleGuard(guard: () => Promise<void>): void { this.lifecycleGuard = guard; }

  /** Intentional stop is one-way for this incarnation. A new registration starts a new runtime. */
  public stopLifecycle(): void {
    this.lifecycleStopped = true;
    this.socketGeneration++;
    this.qrChallenges.invalidate(this.socketGeneration);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.vendor?.end(new Error("Intentional lifecycle stop"));
  }

  /** Authority/storage outage is transport recovery, never intentional pause or logout. */
  public recoverLifecycle(): void {
    if (this.lifecycleStopped) return;
    this.socketGeneration++;
    this.qrChallenges.invalidate(this.socketGeneration);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.vendor?.end(new Error("Lifecycle ingress storage unavailable"));
    this.reportLifecycle("disconnected");
    void this.delayedReconnect();
  }

  private assertSocketCurrent(generation: number): void {
    if (this.lifecycleStopped || generation !== this.socketGeneration) {
      throw Object.assign(new Error("Lifecycle authorization revoked"), { code: "BOT_LIFECYCLE_DENIED" });
    }
  }

  private socketGeneration = 0;
  private qrChallenges = new QrChallengeStore(async (qr) => qrImage.imageSync(qr, { type: "png", margin: 4 }) as Buffer);
  private lifecycleSnapshot: ProviderLifecycleEvent | null = null;
  // Known missing authentication survives replacement sockets until a real open.
  private lifecycleRequiresLink = false;

  public getLifecycleSnapshot = (): ProviderLifecycleEvent | null => this.lifecycleSnapshot;

  private reportLifecycle(state: ProviderLifecycleEvent["state"], reasonCode?: number, phoneNumber?: string): void {
    if (state === "ready") this.lifecycleRequiresLink = false;
    if (state === "requires_link") this.lifecycleRequiresLink = true;
    if (this.lifecycleRequiresLink && (state === "connecting" || state === "disconnected")) state = "requires_link";
    this.lifecycleSnapshot = { state, socketGeneration: this.socketGeneration, observedAt: new Date().toISOString(), ...(reasonCode === undefined ? {} : { reasonCode }), ...(phoneNumber ? { phoneNumber } : {}) };
    this.emit("provider.lifecycle", this.lifecycleSnapshot);
  }

  public globalVendorArgs: BaileyGlobalVendorArgs = {
    name: `bot`,
    gifPlayback: false,
    usePairingCode: false,
    browser: [
      "Windows",
      "Chrome",
      "Chrome 114.0.5735.198",
    ] as WABrowserDescription,
    phoneNumber: null,
    useBaileysStore: true,
    port: 3000,
    timeRelease: 0, //21600000
    writeMyself: "none",
    groupsIgnore: true,
    readStatus: false,
    experimentalStore: false,
    offlineReplayEnabled: false,
    autoRefresh: 0,
    experimentalSyncMessage: undefined,
    fallBackAction: undefined,
  };

  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private reconnectDelay = 1000; // 1 segundo inicial

  /**
   * Techo duro de la escalera de reintentos. Con 20 intentos y el cap de 30s
   * la escalera tarda ~8 min (1+2+4+8+16 + 30*15 = 481s), asi que este techo
   * solo actua si alguien toca los numeros de arriba.
   */
  private static readonly MAX_RECONNECT_WINDOW_MS = 15 * 60 * 1000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

  /** Momento del primer reintento de la racha actual; null si no hay racha. */
  private reconnectWindowStartedAt: number | null = null;

  /**
   * Si al abrir el socket ya habia sesion vinculada en disco. Distingue una
   * reconexion (acotada: si no vuelve, algo esta mal) de un onboarding por QR
   * (ilimitado: el socket cicla a proposito mientras el QR rota y nadie escanea).
   */
  private sessionWasRegistered = false;

  /**
   * Contexto por envio. Baileys permite fijar el messageId antes de enviar,
   * pero Builderbot no expone esa opcion en sus helpers de alto nivel.
   * AsyncLocalStorage evita compartir el id entre envios concurrentes.
   */
  private readonly outboundMessageId = new AsyncLocalStorage<string>();

  msgRetryCounterCache?: NodeCache;
  userDevicesCache?: NodeCache;

  private logger: Console;
  private logStream: NodeJS.WritableStream;

  private idsDuplicates = [];
  private mapSet = new Set();
  private readonly offlineReplayWindow: OfflineReplayWindow;

  constructor(args: Partial<BaileyGlobalVendorArgs>) {
    super();

    this.offlineReplayWindow = new OfflineReplayWindow((event, payload) =>
      this.emit(event, payload)
    );

    this.logStream = createWriteStream(`${process.cwd()}/baileys.log`, {
      flags: "a",
      autoClose: true,
      emitClose: true,
    });

    // El log del provider iba SOLO a baileys.log, un archivo dentro del
    // contenedor. En un deploy efimero (ECS/Railway) eso es invisible: se
    // pierde en cada reinicio, justo cuando mas hace falta. El 2026-09-03 un
    // bot estuvo 3h50m sin socket y no quedo ni un rastro en CloudWatch.
    // Duplicamos a stdout para que las caidas y reconexiones queden en el log
    // del deploy.
    const teeStream = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.logStream.write(chunk);
          process.stdout.write(chunk);
        } catch {
          // Nunca romper el flujo del bot por un fallo de logging.
        }
        callback();
      },
    });

    this.logger = new Console({
      stdout: teeStream,
      stderr: teeStream,
    });

    this.msgRetryCounterCache = new NodeCache({
      stdTTL: 1800, // 30 minutos (más tiempo para reintentos)
      checkperiod: 300, // Limpieza cada 5 minutos (menos frecuente)
      maxKeys: 50000, // 50K entradas (más espacio)
      deleteOnExpire: true,
      useClones: false,
      forceString: false,
      errorOnMissing: false,
    });

    this.userDevicesCache = new NodeCache({
      stdTTL: 7200, // 2 horas (dispositivos cambian poco)
      checkperiod: 600, // Limpieza cada 10 minutos
      maxKeys: 5000, // Más dispositivos
      deleteOnExpire: true,
      useClones: false,
      forceString: false,
      errorOnMissing: false,
    });

    this.globalVendorArgs = { ...this.globalVendorArgs, ...args };

    this.setupCleanupHandlers();
    this.setupPeriodicCleanup();
  }

  /**
   * Setup cleanup handlers
   * @description
   * - Remove existing listeners to prevent duplicates
   * - Add new listeners
   * - Add cleanup function to all listeners
   * - Add cleanup function to uncaughtException and unhandledRejection
   * - Add cleanup function to SIGINT, SIGTERM, SIGUSR1, SIGUSR2
   * - Add cleanup function to process.exit
   */
  private setupCleanupHandlers() {
    const cleanup = () => {
      this.logger.log(
        `[${new Date().toISOString()}] Iniciando limpieza de recursos...`
      );
      this.cleanup();
    };

    // Remove existing listeners to prevent duplicates
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGUSR1");
    process.removeAllListeners("SIGUSR2");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGUSR1", cleanup);
    process.on("SIGUSR2", cleanup);

    process.on("uncaughtException", (error) => {
      this.logger.log(
        `[${new Date().toISOString()}] Uncaught Exception:`,
        error
      );
      this.cleanup();
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      this.logger.log(
        `[${new Date().toISOString()}] Unhandled Rejection at:`,
        promise,
        "reason:",
        reason
      );
    });
  }

  private setupPeriodicCleanup() {
    // Limpiar duplicados cada 10 minutos para evitar memory leaks
    setInterval(() => {
      const maxSize = 1000;
      if (this.idsDuplicates.length > maxSize) {
        this.logger.log(
          `[${new Date().toISOString()}] Cleaning duplicates array: ${this.idsDuplicates.length
          } -> ${maxSize}`
        );
        this.idsDuplicates = this.idsDuplicates.slice(-maxSize); // Mantener solo los últimos 1000
      }

      // Limpiar mapSet si tiene demasiadas entradas
      if (this.mapSet.size > maxSize) {
        this.logger.log(
          `[${new Date().toISOString()}] Cleaning mapSet: ${this.mapSet.size
          } -> 0`
        );
        this.mapSet.clear();
      }
    }, 600000); // 10 minutos
  }

  private cleanup() {
    try {
      if (this.msgRetryCounterCache) {
        this.msgRetryCounterCache.close();
        this.msgRetryCounterCache = undefined;
      }

      if (this.userDevicesCache) {
        this.userDevicesCache.close();
        this.userDevicesCache = undefined;
      }

      this.mapSet.clear();
      this.idsDuplicates.length = 0;

      if (this.logStream && typeof this.logStream.end === "function") {
        this.logStream.end();
      }

      this.logger.log(
        `[${new Date().toISOString()}] Recursos limpiados correctamente`
      );
    } catch (error) {
      console.error("Error durante cleanup:", error);
    }
  }

  public async releaseSessionFiles() {
    const NAME_DIR_SESSION = `${this.globalVendorArgs.name}_sessions`;
    const idTimer = await releaseTmp(NAME_DIR_SESSION, 0);
    clearInterval(idTimer);
  }

  protected beforeHttpServerInit(): void {
    this.server = this.server
      .use((req: any, _: any, next: () => any) => {
        req["globalVendorArgs"] = this.globalVendorArgs;
        return next();
      })
      .get("/qr/metadata", this.qrMetadata)
      .get("/", this.indexHome);
  }

  protected afterHttpServerInit(): void { }

  public qrMetadata: polka.Middleware = (_req, res) => {
    const current = this.qrChallenges.current();
    res.writeHead(200, { "Cache-Control": "private, no-store", "Content-Type": "application/json" });
    res.end(JSON.stringify({ instanceId: this.qrInstanceId, available: Boolean(current), ...(current ? {
      generation: current.socketGeneration, revision: current.revision,
      expiresAt: new Date(current.expiresAt).toISOString(),
    } : {}) }));
  };

  public indexHome: polka.Middleware = (req, res) => {
    const current = this.qrChallenges.current();
    const headers = { "Cache-Control": "private, no-store" };
    const query = req.query || {};
    const conditional = [query.qrInstanceId, query.qrGeneration, query.qrRevision].some(value => value !== undefined);
    if (conditional && (!current || query.qrInstanceId !== this.qrInstanceId || String(query.qrGeneration) !== String(current.socketGeneration) || String(query.qrRevision) !== String(current.revision))) {
      res.writeHead(409, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "qr_changed" }));
      return;
    }
    if (!current) {
      res.writeHead(503, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "waiting_qr" }));
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Content-Type": "image/png",
      "X-QR-Instance-Id": this.qrInstanceId,
      "X-QR-Generation": String(current.socketGeneration),
      "X-QR-Revision": String(current.revision),
      "X-QR-Expires-At": new Date(current.expiresAt).toISOString(),
    });
    res.end(current.image);
  };

  protected getMessage = async (key: { remoteJid: string; id: string }) => {
    // only if store is present
    return proto.Message.create({});
  };

  protected saveCredsGlobal: (() => Promise<void>) | null = null;

  /**
   * Iniciar todo Bailey
   */
  protected initVendor = async () => {
    if (this.lifecycleStopped) return;
    const socketGeneration = ++this.socketGeneration;
    this.lifecycleSnapshot = null;
    this.qrChallenges.invalidate(socketGeneration);
    const NAME_DIR_SESSION = `${this.globalVendorArgs.name}_sessions`;
    const { state, saveCreds } = await useMultiFileAuthState(NAME_DIR_SESSION);
    if (socketGeneration !== this.socketGeneration) return;
    const hasLinkedIdentity =
      Boolean(state.creds.registered) || Boolean(state.creds.me?.id);
    // Lo guardamos porque `delayedReconnect` necesita distinguir onboarding por
    // QR de una reconexion con sesion ya vinculada: ver `giveUpAndExit`.
    this.sessionWasRegistered = hasLinkedIdentity;
    this.offlineReplayWindow.open(
      hasLinkedIdentity && this.globalVendorArgs.offlineReplayEnabled === true
    );
    // `fatal` silenciaba toda la capa WebSocket de Baileys: cuando el socket se
    // caia no habia ni una linea que explicara por que. `warn` deja pasar los
    // errores de conexion sin inundar el log con el trafico normal.
    const loggerBaileys = pino({ level: "warn" });

    this.saveCredsGlobal = saveCreds;

    try {
      if (this.globalVendorArgs.useBaileysStore) {
        if (this.globalVendorArgs.timeRelease > 0) {
          await releaseTmp(NAME_DIR_SESSION, this.globalVendorArgs.timeRelease);
        }
      }
    } catch (e) {
      this.logger.log(e);
      this.initVendor().then((v) => this.listenOnEvents(v));
    }

    if (socketGeneration !== this.socketGeneration || this.lifecycleStopped) return;
    try {
      const sock = makeWASocketOther({
        logger: loggerBaileys,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys),
        },
        browser: this.globalVendorArgs.browser as WABrowserDescription,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true,
        getMessage: this.getMessage,
        msgRetryCounterCache: this.msgRetryCounterCache as any,
        userDevicesCache: this.userDevicesCache as any,
        retryRequestDelayMs: 1000, // Mayor delay entre reintentos
        connectTimeoutMs: 60_000, // 1 minuto timeout conexión
        keepAliveIntervalMs: 10_000, // Keep alive cada 10 segundos
        qrTimeout: 40_000, // 40 segundos para QR
        defaultQueryTimeoutMs: 60_000, // 1 minuto para queries
        emitOwnEvents: false, // No emitir eventos propios
        shouldIgnoreJid: (jid: string) => {
          if (this.globalVendorArgs.groupsIgnore) {
            return isJidGroup(jid) || isJidBroadcast(jid);
          }
          return false;
        },
        ...this.globalVendorArgs,
      });

      const sendMessage = sock.sendMessage?.bind(sock);
      if (sendMessage) {
        sock.sendMessage = (async (...args: Parameters<WASocket["sendMessage"]>) => {
          this.assertSocketCurrent(socketGeneration);
          await this.lifecycleGuard?.();
          this.assertSocketCurrent(socketGeneration);
          const network = async () => {
            this.assertSocketCurrent(socketGeneration);
            return sendMessage(...args);
          };
          return this.lifecycleSendWrapper
            ? this.lifecycleSendWrapper({ to: args[0], content: args[1], options: args[2] }, network)
            : network();
        }) as WASocket["sendMessage"];
      }
      this.vendor = sock;
      if (
        this.globalVendorArgs.usePairingCode &&
        !sock.authState.creds.registered
      ) {
        if (this.globalVendorArgs.phoneNumber) {
          const phoneNumberClean = utils.removePlus(
            this.globalVendorArgs.phoneNumber
          );
          await utils.delay(2000);
          this.emit("require_action", {
            title: "⚡⚡ ACTION REQUIRED ⚡⚡",
            instructions: [
              `Accept the WhatsApp notification from ${this.globalVendorArgs.phoneNumber} on your phone 👌`,
              `Need help: https://link.codigoencasa.com/DISCORD`,
            ],
            payload: { qr: null },
          });
        } else {
          this.emit("auth_failure", [
            `The phone number has not been defined, please add it`,
            `Restart the BOT`,
            `You can also check a log that has been created baileys.log`,
            `Need help: https://link.codigoencasa.com/DISCORD`,
          ]);
        }
      }

      sock.ev.on(
        "connection.update",
        async (update: {
          connection: any;
          lastDisconnect: any;
          qr: any;
          receivedPendingNotifications?: boolean;
        }) => {
          if (socketGeneration !== this.socketGeneration) return;
          const {
            connection,
            lastDisconnect,
            qr,
            receivedPendingNotifications,
          } = update;

          this.logger.log(
            `[${new Date().toISOString()}] Connection update: ${connection}`
          );

          const statusCode = (lastDisconnect?.error as Boom)?.output
            ?.statusCode;
          const reason = lastDisconnect?.error?.message;

          if (connection === "connecting") this.reportLifecycle("connecting");

          /** Connection closed for various reasons */
          if (connection === "close") {
            this.qrChallenges.invalidate(socketGeneration);
            this.reportLifecycle(statusCode === DisconnectReason.loggedOut ? "requires_link" : "disconnected", statusCode);
            this.logger.log(
              `[${new Date().toISOString()}] Connection closed. Status: ${statusCode}, Reason: ${reason}`
            );

            // Casos donde NO debemos reconectar
            if (statusCode === DisconnectReason.loggedOut) {
              this.logger.log(
                `[${new Date().toISOString()}] Logged out, clearing session and restarting...`
              );
              const PATH_BASE = join(
                process.cwd(),
                `${this.globalVendorArgs.name}_sessions`
              );
              await emptyDirSessions(PATH_BASE);
              this.reconnectAttempts = 0;
              this.reconnectWindowStartedAt = null;
              // Se borro la sesion: lo que viene es un onboarding por QR, no una
              // reconexion. Sin esto el primer reintento se contaria como acotado.
              this.sessionWasRegistered = false;
              await this.delayedReconnect();
              return;
            }

            // Casos donde debemos reconectar con backoff
            if (this.shouldReconnect(statusCode)) {
              await this.delayedReconnect();
              return;
            }

            // Codigo no listado como recuperable. Antes esto emitia
            // `auth_failure` y no hacia nada mas: el proceso seguia vivo y mudo
            // para siempre. Ahora igual recorremos la escalera de reintentos
            // (que termina en `giveUpAndExit`): si el corte era transitorio se
            // recupera, y si no, el proceso muere y el supervisor lo reinicia.
            this.logger.log(
              `[${new Date().toISOString()}] Unrecognized disconnect status ${statusCode} (${reason}); retrying before giving up`
            );
            await this.delayedReconnect();
          }

          /** Connection opened successfully */
          if (connection === "open") {
            this.qrChallenges.invalidate(socketGeneration);
            const linkedId = sock?.user?.id;
            const linkedPhone = linkedId?.endsWith("@s.whatsapp.net") ? linkedId.split(/[:@]/)[0] : undefined;
            this.reportLifecycle("ready", undefined, linkedPhone);
            this.logger.log(
              `[${new Date().toISOString()}] Connection opened successfully`
            );
            this.reconnectAttempts = 0; // Reset counter on successful connection
            this.reconnectDelay = 1000; // Reset delay
            this.reconnectWindowStartedAt = null; // Arranca una racha nueva

            const parseNumber = `${sock?.user?.id}`.split(":").shift();
            const host = { ...sock?.user, phone: parseNumber };
            this.globalVendorArgs.host = host;
            this.emit("ready", true);
            this.emit("host", host);
          }

          if (receivedPendingNotifications === true) {
            this.offlineReplayWindow.complete();
          }

          /** Publish only the current fully rendered challenge; never log its payload. */
          if (qr && !this.globalVendorArgs.usePairingCode && this.lifecycleSnapshot?.state !== "ready") {
            const ttl = Number((this.globalVendorArgs as any).qrTimeout) || 40_000;
            const artifact = await this.qrChallenges.publish(qr, socketGeneration, ttl);
            if (!artifact) return;
            this.reportLifecycle("requires_link");
            this.emit("require_action", {
              title: "ACTION REQUIRED",
              instructions: ["Scan the current QR code before its displayed expiry."],
              payload: { qr },
            });
          }
        }
      );

      sock.ev.on("creds.update", async () => {
        if (socketGeneration !== this.socketGeneration) return;
        await saveCreds();
      });

      return sock.ev;
    } catch (e) {
      if (socketGeneration !== this.socketGeneration) return;
      this.qrChallenges.invalidate(socketGeneration);
      this.reportLifecycle("error");
      this.logger.log(e);
      this.emit("auth_failure", [
        `Something unexpected has occurred, do not panic`,
        `Restart the BOT`,
        `You can also check a log that has been created baileys.log`,
        `Need help: https://link.codigoencasa.com/DISCORD`,
      ]);
    }
  };

  /**
   * Map native events that the Provider class expects
   * to have a standard set of events
   * @returns
   */
  protected busEvents = (): {
    event: keyof BaileysEventMap;
    func: (arg?: any, arg2?: any) => any;
  }[] => [
      {
        event: "messages.upsert",
        func: async (argFromProvider) => {
          if (this.lifecycleStopped) return;
          const { messages, type } = argFromProvider as {
            type: MessageUpsertType;
            messages: WAMessage[];
          };
          if (type === "append") {
            for (const message of messages || []) {
              if (message?.key?.fromMe) continue;
              if (!message?.key?.id) continue;
              this.offlineReplayWindow.capture(message, "append");
            }
            return;
          }
          if (type !== "notify") return;

          const pingMessageSync = async (_messageCtx: proto.IWebMessageInfo) => {
            if (!this.mapSet.has(_messageCtx?.key?.remoteJid)) {
              try {
                this.mapSet.add(_messageCtx?.key?.remoteJid);
                const jid = _messageCtx?.key?.remoteJid;

                // Removed readMessages() call - Baileys v7 no longer sends ACKs to prevent bans
                await this.vendor.sendMessage(jid, {
                  text: this.globalVendorArgs.experimentalSyncMessage,
                });
              } catch (e) {
                this.logger.log(e);
              }
            }
          };

          for (const messageCtx of messages) {
            const textToBody =
              messageCtx?.message?.ephemeralMessage?.message?.extendedTextMessage
                ?.text ??
              messageCtx?.message?.extendedTextMessage?.text ??
              messageCtx?.message?.conversation;

            // This control message must run before the replay gate. Otherwise a
            // reconnect window consumes it as normal replay traffic and the
            // history request is never sent.
            if (textToBody === "onDemandHistSync") {
              try {
                if (this.vendor.fetchMessageHistory) {
                  this.offlineReplayWindow.open(true);
                  const messageId = await this.vendor.fetchMessageHistory(
                    50,
                    messageCtx.key,
                    messageCtx.messageTimestamp
                  );
                  this.logger.log(
                    `[${new Date().toISOString()}] Requested on-demand sync, id=${messageId}`
                  );
                } else {
                  this.logger.log(
                    `[${new Date().toISOString()}] On-demand history sync is unavailable`
                  );
                }
              } catch (e) {
                this.offlineReplayWindow.complete();
                this.logger.log(
                  `[${new Date().toISOString()}] Error requesting history sync:`,
                  e
                );
              }
              continue;
            }

            if (
              this.offlineReplayWindow.isActive() &&
              !messageCtx?.key?.fromMe
            ) {
              if (messageCtx?.key?.id) {
                this.offlineReplayWindow.capture(messageCtx, "notify");
              }
              continue;
            }
            if (
              messageCtx?.messageStubParameters?.length &&
              messageCtx.messageStubParameters[0].includes("absent")
            )
              continue;
            if (
              messageCtx?.messageStubParameters?.length &&
              messageCtx.messageStubParameters[0].includes("No session")
            )
              continue;
            if (
              messageCtx?.messageStubParameters?.length &&
              messageCtx.messageStubParameters[0].includes("Bad MAC")
            )
              continue;
            if (
              messageCtx?.messageStubParameters?.length &&
              messageCtx.messageStubParameters[0].includes("Invalid")
            ) {
              if (this.globalVendorArgs.fallBackAction) {
                try {
                  await this.globalVendorArgs.fallBackAction(messageCtx);
                } catch (error) {
                  continue;
                }
                continue;
              }

              if (
                this.globalVendorArgs.experimentalSyncMessage &&
                this.globalVendorArgs.experimentalSyncMessage.length
              ) {
                if (baileyIsValidNumber(messageCtx?.key?.remoteJid)) {
                  await pingMessageSync(messageCtx);
                }
                continue;
              }
              continue;
            }
            // if (((messageCtx?.message?.protocolMessage?.type) as unknown as string) === 'EPHEMERAL_SETTING') continue

            if (textToBody) {
              if (
                textToBody === "requestPlaceholder" &&
                !(messageCtx as any).requestId
              ) {
                try {
                  if (this.vendor.requestPlaceholderResend) {
                    const messageId = await this.vendor.requestPlaceholderResend(
                      messageCtx.key
                    );
                    this.logger.log(
                      `[${new Date().toISOString()}] Requested placeholder resync, id=${messageId}`
                    );
                  }
                  continue; // No procesar como mensaje normal
                } catch (e) {
                  this.logger.log(
                    `[${new Date().toISOString()}] Error requesting placeholder resync:`,
                    e
                  );
                }
              }

              if ((messageCtx as any).requestId) {
                this.logger.log(
                  `[${new Date().toISOString()}] Message received from phone, id=${(messageCtx as any).requestId
                  }`,
                  messageCtx
                );
              }
            }

            let payload = {
              ...messageCtx,
              body: textToBody,
              name: messageCtx?.pushName,
              from: messageCtx?.key?.remoteJid,
            };

            if (messageCtx.message?.locationMessage) {
              const { degreesLatitude, degreesLongitude } =
                messageCtx.message.locationMessage;
              if (
                typeof degreesLatitude === "number" &&
                typeof degreesLongitude === "number"
              ) {
                payload = {
                  ...payload,
                  body: utils.generateRefProvider("_event_location_"),
                };
              }
            }

            if (messageCtx.message?.videoMessage) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_media_"),
              };
            }

            if (messageCtx.message?.stickerMessage) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_media_"),
              };
            }

            if (messageCtx.message?.imageMessage) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_media_"),
              };
            }

            if (
              messageCtx.message?.documentMessage ||
              messageCtx.message?.documentWithCaptionMessage
            ) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_document_"),
              };
            }

            if (messageCtx.message?.audioMessage) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_voice_note_"),
              };
            }

            if (messageCtx.message?.orderMessage) {
              payload = {
                ...payload,
                body: utils.generateRefProvider("_event_order_"),
              };
            }

            if (payload.from === "status@broadcast") continue;
            payload.from = baileyCleanNumber(payload.from, true);

            if (
              this.globalVendorArgs.writeMyself === "none" &&
              payload?.key?.fromMe
            )
              continue;
            if (
              this.globalVendorArgs.host?.phone !== payload.from &&
              payload?.key?.fromMe &&
              !["both"].includes(this.globalVendorArgs.writeMyself)
            )
              continue;
            if (
              this.globalVendorArgs.host?.phone === payload.from &&
              !["both", "host"].includes(this.globalVendorArgs.writeMyself)
            )
              continue;

            if (!baileyIsValidNumber(payload.from)) {
              continue;
            }

            const btnCtx =
              payload?.message?.buttonsResponseMessage?.selectedDisplayText;
            if (btnCtx) payload.body = btnCtx;

            const listRowId = payload?.message?.listResponseMessage?.title;
            if (listRowId) payload.body = listRowId;

            const processDuplicate = () => {
              if (messageCtx?.key?.id) {
                const idWs = `${messageCtx.key.id}__${payload.from}`;
                const isDuplicate = this.idsDuplicates.includes(idWs);
                if (isDuplicate) {
                  this.idsDuplicates = [];
                  return false;
                }
                if (this.idsDuplicates.length > 10) {
                  this.idsDuplicates = [];
                }
                this.idsDuplicates.push(idWs);
              }
              return true;
            };

            // Admission owns this synchronous callback: no await may separate final
            // local protocol validation from dedup and business listener handoff.
            const dispatch = () => {
              if (this.lifecycleStopped || !processDuplicate()) return false;
              this.emit("message", payload);
              return true;
            };
            if (this.lifecycleIncomingGate) await this.lifecycleIncomingGate(payload, dispatch);
            else dispatch();
          }
        },
      },
      {
        event: "messaging-history.set",
        func: async (history) => {
          const { messages = [] } = history as { messages?: WAMessage[] };
          for (const message of messages) {
            if (message?.key?.fromMe) continue;
            if (!message?.key?.id) continue;
            this.offlineReplayWindow.capture(message, "history");
          }
          this.offlineReplayWindow.complete();
        },
      },
      {
        event: "messages.update",
        func: async (message) => {
          for (const { key, update } of message) {
            const status = update.status as number;
            if (key?.id && Number.isFinite(status)) {
              const stage = BAILEYS_STATUS_STAGE[status] || "unknown";
              const error = stage === "error" ? statusErrorEvidence(update) : undefined;
              const payload: BaileysMessageStatusEvent = {
                provider: "baileys",
                providerMessageId: key.id,
                remoteJid: key.remoteJid ?? null,
                fromMe: key.fromMe ?? null,
                status,
                stage,
                observedAt: new Date().toISOString(),
                ...(error ? { error } : {}),
              };
              this.emit("message_status", payload);
            }
            if (update.pollUpdates) {
              const pollCreation = await this.getMessage(key);
              if (pollCreation) {
                const pollMessage = getAggregateVotesInPollMessage({
                  message: pollCreation,
                  pollUpdates: update.pollUpdates,
                });
                const [messageCtx] = message;

                if (
                  !messageCtx ||
                  !messageCtx.update ||
                  !messageCtx.update.pollUpdates ||
                  messageCtx.update.pollUpdates.length === 0
                ) {
                  continue;
                }

                const payload = {
                  ...messageCtx,
                  body:
                    pollMessage.find((poll) => poll.voters.length > 0)?.name ||
                    "",
                  from: baileyCleanNumber(key.remoteJid, true),
                  voters: pollCreation,
                  type: "poll",
                };
                const dispatch = () => { if (this.lifecycleStopped) return false; this.emit("message", payload); return true; };
                if (this.lifecycleIncomingGate) await this.lifecycleIncomingGate(payload, dispatch);
                else dispatch();
              }
            }
          }
        },
      },
      {
        event: "call",
        func: async ([call]) => {
          if (call.status === "offer") {
            const payload = {
              from: baileyCleanNumber(call.from, true),
              body: utils.generateRefProvider("_event_call_"),
              call,
            };

            const dispatch = () => { if (this.lifecycleStopped) return false; this.emit("message", payload); return true; };
            if (this.lifecycleIncomingGate) await this.lifecycleIncomingGate(payload, dispatch);
            else dispatch();
            // Opcional: Rechazar automáticamente la llamada
            // await this.vendor.rejectCall(call.id, call.from)
          }
        },
      },
    ];

  /**
   * Ejecuta una operacion de envio usando un id fijado por el caller.
   * El Promise de sendMessage sigue significando solamente que Baileys escribio
   * el stanza: la aceptacion real llega despues por messages.update.
   */
  runWithMessageId = async <T>(messageId: string, send: () => Promise<T>): Promise<T> => {
    const normalized = messageId?.trim();
    if (!normalized) throw new Error("messageId is required");
    return this.outboundMessageId.run(normalized, send);
  };

  /** Unico punto por el que pasan los helpers publicos de envio. */
  /**
   * Mandar a un numero que no existe en WhatsApp NO falla: `getUSyncDevices`
   * resuelve cero dispositivos, `relayMessage` cifra para nadie, `sendMessage`
   * resuelve OK con un id generado localmente y no llega ningun acuse jamas.
   * Todas las capas informan exito y el mensaje no le llega a nadie.
   *
   * Se comprueba antes de enviar, en dos niveles:
   *
   *  1. `baileyIsPossibleNumber` — determinista y gratis. Si el numero no puede
   *     existir, se corta con error. Sin falsos negativos.
   *  2. `onWhatsApp` — autoritativo: se lo pregunta a WhatsApp. Si la consulta
   *     falla (red, rate limit), se deja pasar el envio: una consulta rota no
   *     puede bloquear mensajes buenos.
   *
   * El resultado se cachea para no pagar una consulta USync por mensaje.
   *
   * OJO CON LA FORMA DE LA RESPUESTA. `onWhatsApp` NO devuelve `exists:false`
   * para un numero que no existe: lo FILTRA. En baileys 7.0.0-rc14
   * (Socket/socket.js) la ultima linea es
   *
   *     results.list.filter(a => !!a.contact).map(({contact, id}) => ({jid: id, exists: contact}))
   *
   * y `contact` viene de `node.attrs.type === 'in'`, o sea un booleano. El
   * `.filter(!!a.contact)` se come justamente las entradas de los numeros que no
   * existen, asi que `exists` en el array devuelto vale SIEMPRE `true`. Buscar
   * `exists === false` es esperar algo que no llega nunca.
   *
   * La ausencia es la respuesta: si el numero no vuelve en el resultado, no
   * tiene WhatsApp. Y hay que distinguir dos vacios que significan lo opuesto:
   *
   *     []        -> WhatsApp contesto y el numero no esta   => no existe
   *     undefined -> la consulta no contesto                 => no sabemos
   *
   * Medido contra produccion el 2026-09-04 con 41 numeros de resultado conocido
   * (24 destinos que habian perdido mensajes, 15 buenos, 2 inventados): 41/41
   * concluyentes, 0 falsos negativos. El heuristico de largo por si solo
   * atrapaba 4 de esos 24; los otros 20 tienen largo valido y solo los ve esta
   * consulta.
   */
  private numeroExisteCache = new NodeCache({
    // Positivos largos: un numero que existe no deja de existir.
    // Los negativos se guardan con TTL corto (ver `recordarNoExiste`) para que
    // alguien que se acaba de crear la cuenta no quede bloqueado media hora.
    stdTTL: 86400,
    checkperiod: 3600,
    useClones: false,
  });

  private async numeroPuedeRecibir(remoteJid: string): Promise<true | string> {
    // Grupos y difusiones no pasan por USync.
    if (isJidGroup(remoteJid) || isJidBroadcast(remoteJid)) return true;

    const digits = baileyCleanNumber(remoteJid, true);

    if (!baileyIsPossibleNumber(digits)) {
      return `el numero no puede existir (${digits.length} digitos)`;
    }

    const cacheado = this.numeroExisteCache.get<boolean>(digits);
    if (cacheado === false) return "WhatsApp dice que el numero no existe";
    if (cacheado === true) return true;

    try {
      const resultado = await this.vendor.onWhatsApp(digits);
      // `undefined` es "no contesto", y no autoriza ninguna conclusion.
      if (Array.isArray(resultado)) {
        const encontrado = resultado.some((entrada: { jid?: string }) => {
          const jid = String(entrada?.jid ?? "")
            .split("@")[0]
            .split(":")[0]
            .replace(/\D/g, "");
          return Boolean(jid) && (jid === digits || jid.startsWith(digits));
        });
        if (!encontrado) {
          this.numeroExisteCache.set(digits, false, 600);
          return "WhatsApp dice que el numero no existe";
        }
        this.numeroExisteCache.set(digits, true);
      }
    } catch (e) {
      // Fail-open a proposito: no bloquear por una consulta rota.
      this.logger.log(
        `[${new Date().toISOString()}] onWhatsApp fallo para ${digits}, se envia igual: ${(e as Error)?.message}`,
      );
    }
    return true;
  }

  private sendVendorMessage = async <T = WAMessage>(
    remoteJid: string,
    content: AnyMessageContent,
    options?: Record<string, unknown>,
  ): Promise<T> => {
    const motivo = await this.numeroPuedeRecibir(remoteJid);
    if (motivo !== true) {
      this.logger.log(
        `[${new Date().toISOString()}] [ENVIO_RECHAZADO] ${remoteJid}: ${motivo}`,
      );
      this.emit("send_rejected", { remoteJid, reason: motivo });
      // El `code` es contrato con el consumidor durable. Sin el, arriba solo hay
      // un Error generico: se clasifica como resultado desconocido y el saliente
      // termina en cuarentena silenciosa, que es el mismo final que teniamos
      // antes del guard. Con el, se sabe que NO se envio y se puede decir por que.
      const error = new Error(
        `No se puede enviar a ${remoteJid}: ${motivo}`,
      ) as Error & { code: string; remoteJid: string; reason: string };
      error.code = BAILEYS_DESTINATION_UNREACHABLE;
      error.remoteJid = remoteJid;
      error.reason = motivo;
      throw error;
    }

    const messageId = this.outboundMessageId.getStore();
    if (!messageId && options === undefined) {
      return this.vendor.sendMessage(remoteJid, content) as Promise<T>;
    }
    return this.vendor.sendMessage(remoteJid, content, {
      ...(options || {}),
      ...(messageId ? { messageId } : {}),
    }) as Promise<T>;
  };

  /**
   * @param {string} orderId
   * @param {string} orderToken
   * @example await getOrderDetails('order-id', 'order-token')
   */
  getOrderDetails = async (orderId: string, orderToken: string) => {
    const orderDetails = await this.vendor.getOrderDetails(orderId, orderToken);
    return orderDetails;
  };

  /**
   * Obtener LID (Local Identifier) para un número de teléfono (PN)
   * @param {string} phoneNumber - Número de teléfono en formato JID (e.g., '1234567890@s.whatsapp.net')
   * @returns {Promise<string|null>} - El LID correspondiente o null si no se encuentra
   * @example await getLIDForPN('1234567890@s.whatsapp.net')
   */
  getLIDForPN = async (phoneNumber: string) => {
    try {
      const vendor = this.vendor as any;
      if (vendor?.signalRepository?.lidMapping?.getLIDForPN) {
        return await vendor.signalRepository.lidMapping.getLIDForPN(
          phoneNumber
        );
      }
      return null;
    } catch (e) {
      this.logger.log(
        `[${new Date().toISOString()}] Error getting LID for PN:`,
        e
      );
      return null;
    }
  };

  /**
   * Obtener número de teléfono (PN) para un LID (Local Identifier)
   * @param {string} lid - Local Identifier
   * @returns {Promise<string|null>} - El número de teléfono correspondiente o null si no se encuentra
   * @example await getPNForLID('lid:xxxxxx')
   */
  getPNForLID = async (lid: string) => {
    try {
      const vendor = this.vendor as any;
      if (vendor?.signalRepository?.lidMapping?.getPNForLID) {
        return await vendor.signalRepository.lidMapping.getPNForLID(lid);
      }
      return null;
    } catch (e) {
      this.logger.log(
        `[${new Date().toISOString()}] Error getting PN for LID:`,
        e
      );
      return null;
    }
  };

  /**
   * @param {string} number
   * @param {string} message
   * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
   */

  sendMedia = async (number: string, imageUrl: string, text: string) => {
    const fileDownloaded = await utils.generalDownload(imageUrl);
    const mimeType = mime.lookup(fileDownloaded);
    if (`${mimeType}`.includes("image"))
      return this.sendImage(number, fileDownloaded, text);
    if (`${mimeType}`.includes("video"))
      return this.sendVideo(number, fileDownloaded, text);
    if (`${mimeType}`.includes("audio")) {
      const fileOpus = await utils.convertAudio(fileDownloaded);
      return this.sendAudio(number, fileOpus);
    }
    return this.sendFile(number, fileDownloaded, text);
  };

  /**
   * Enviar imagen
   * @param {*} number
   * @param {*} imageUrl
   * @param {*} text
   * @returns
   */
  sendImage = async (number: string, filePath: string, text: any) => {
    const payload: AnyMediaMessageContent = {
      image: { url: filePath },
      caption: text,
    };
    return this.sendVendorMessage(number, payload);
  };

  /**
   * Enviar video
   * @param {*} number
   * @param {*} imageUrl
   * @param {*} text
   * @returns
   */
  sendVideo = async (
    number: string,
    filePath: PathOrFileDescriptor,
    text: any
  ) => {
    const payload: AnyMediaMessageContent = {
      video: readFileSync(filePath),
      caption: text,
      gifPlayback: this.globalVendorArgs.gifPlayback,
    };
    return this.sendVendorMessage(number, payload);
  };

  /**
   * Enviar audio
   * @alpha
   * @param {string} number
   * @param {string} message
   * @param {boolean} voiceNote optional
   * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
   */

  sendAudio = async (number: string, audioUrl: string) => {
    const payload: AnyMediaMessageContent = {
      audio: { url: audioUrl },
      ptt: true,
    };
    return this.sendVendorMessage(number, payload);
  };

  /**
   *
   * @param {string} number
   * @param {string} message
   * @returns
   */
  sendText = async (number: string, message: string) => {
    const payload: AnyMessageContent = { text: message };
    return this.sendVendorMessage(number, payload);
  };

  /**
   *
   * @param {string} number
   * @param {string} filePath
   * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
   */

  sendFile = async (number: string, filePath: string, text: string) => {
    const mimeType = mime.lookup(filePath);
    const fileName = basename(filePath);

    const payload: AnyMessageContent = {
      document: { url: filePath },
      mimetype: `${mimeType}`,
      fileName: fileName,
      caption: text,
    };

    return this.sendVendorMessage(number, payload);
  };

  /**
   * @deprecated Buttons are not available in this provider, please use sendButtons instead
   * @private
   * @param {string} number
   * @param {string} text
   * @param {string} footer
   * @param {Array} buttons
   * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
   */

  sendButtons = async (number: string, text: string, buttons: Button[]) => {
    this.emit("notice", {
      title: "DEPRECATED",
      instructions: [
        `Currently sending buttons is not available with this provider`,
        `this function is available with Meta or Twilio`,
      ],
    });
    const numberClean = baileyCleanNumber(number);
    const templateButtons = buttons.map((btn: { body: any }, i: any) => ({
      buttonId: `id-btn-${i}`,
      buttonText: { displayText: btn.body },
      type: 1,
    }));

    const buttonMessage = {
      text,
      footer: "",
      buttons: templateButtons,
      headerType: 1,
    };

    return this.sendVendorMessage(numberClean, buttonMessage as AnyMessageContent);
  };


  /**
   * TODO: Necesita terminar de implementar el sendMedia y sendButton guiarse:
   * https://github.com/leifermendez/bot-whatsapp/blob/4e0fcbd8347f8a430adb43351b5415098a5d10df/packages/provider/src/web-whatsapp/index.js#L165
   * @param {string} number
   * @param {string} message
   * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
   */

  sendMessage = async (
    numberIn: string,
    message: string,
    options?: SendOptions
  ): Promise<any> => {
    options = { ...options, ...options["options"] };
    const number = baileyCleanNumber(`${numberIn}`);
    if (options.buttons?.length)
      return this.sendButtons(number, message, options.buttons);
    if (options.media) return this.sendMedia(number, options.media, message);
    return this.sendText(number, message);
  };

  /**
   * @param {string} remoteJid
   * @param {string} latitude
   * @param {string} longitude
   * @param {any} messages
   * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
   */

  sendLocation = async (
    remoteJid: string,
    latitude: any,
    longitude: any,
    messages: any = null
  ): Promise<any> => {
    const response = await this.sendVendorMessage(
      remoteJid,
      {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
        },
      },
      { quoted: messages }
    );
    return this.outboundMessageId.getStore() ? response : { status: "success" };
  };

  /**
   * @param {string} remoteJid
   * @param {string} contactNumber
   * @param {string} displayName
   * @param {string} orgName
   * @param {any} messages - optional
   * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
   */

  sendContact = async (
    remoteJid: any,
    contactNumber: { replaceAll: (arg0: string, arg1: string) => any },
    displayName: string,
    orgName: string,
    messages: any = null
  ): Promise<any> => {
    const cleanContactNumber = contactNumber.replaceAll(" ", "");
    const waid = cleanContactNumber.replace("+", "");

    const vcard =
      "BEGIN:VCARD\n" +
      "VERSION:3.0\n" +
      `FN:${displayName}\n` +
      `ORG:${orgName};\n` +
      `TEL;type=CELL;type=VOICE;waid=${waid}:${cleanContactNumber}\n` +
      "END:VCARD";

    const response = await this.sendVendorMessage(
      remoteJid,
      {
        contacts: {
          displayName: ".",
          contacts: [{ vcard }],
        },
      },
      { quoted: messages }
    );
    return this.outboundMessageId.getStore() ? response : { status: "success" };
  };

  /**
   * @param {string} remoteJid
   * @param {string} WAPresence
   * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
   */
  sendPresenceUpdate = async (remoteJid: any, WAPresence: any) => {
    await this.vendor.sendPresenceUpdate(WAPresence, remoteJid);
  };

  /**
   * @param {string} remoteJid
   * @param {string} url
   * @param {object} stickerOptions
   * @param {any} messages - optional
   * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'} messages)
   */

  sendSticker = async (
    remoteJid: any,
    url: string | Buffer,
    stickerOptions: Partial<IStickerOptions>,
    messages: any = null
  ) => {
    const sticker = new Sticker(url, {
      ...stickerOptions,
      quality: 50,
      type: "crop",
    });

    const buffer = await sticker.toMessage();

    return this.sendVendorMessage(
      remoteJid,
      buffer as AnyMessageContent,
      { quoted: messages },
    );
  };

  private getMimeType = (ctx: WAMessage): string | undefined => {
    const { message } = ctx;
    if (!message) return undefined;

    const {
      imageMessage,
      videoMessage,
      documentMessage,
      audioMessage,
      documentWithCaptionMessage,
    } = message;
    return (
      imageMessage?.mimetype ??
      audioMessage?.mimetype ??
      videoMessage?.mimetype ??
      documentMessage?.mimetype ??
      documentWithCaptionMessage?.message?.documentMessage?.mimetype
    );
  };

  private generateFileName = (extension: string): string =>
    `file-${Date.now()}.${extension}`;

  /**
   * Return Path absolute
   * @param ctx
   * @param options
   * @returns
   */
  saveFile = async (
    ctx: Partial<WAMessage & BotContext>,
    options?: { path: string }
  ): Promise<string> => {
    const mimeType = this.getMimeType(ctx as WAMessage);
    if (!mimeType) throw new Error("MIME type not found");
    const extension = mime.extension(mimeType) as string;
    const buffer = await downloadMediaMessage(ctx as WAMessage, "buffer", {});
    const fileName = this.generateFileName(extension);

    const pathFile = join(options?.path ?? tmpdir(), fileName);
    await writeFile(pathFile, buffer);
    return resolve(pathFile);
  };

  /**
   * Antes, agotar los reintentos solo emitia `auth_failure` y volvia: el proceso
   * quedaba vivo con el socket muerto. Invisible para ECS (los bots no tienen
   * healthCheck) y para el webhook de status, que seguia reportando "Activo".
   * El 2026-09-03 un bot estuvo asi 3h50m y solo volvio porque un deploy no
   * relacionado lo reinicio; se perdieron 36 mensajes entrantes.
   *
   * Ahora terminamos el proceso a proposito: PM2 corre dentro del contenedor en
   * modo fork y lo levanta de nuevo en segundos, reconectando con la sesion
   * intacta en disco. Si PM2 no estuviera, ECS reemplaza la task.
   */
  private giveUpAndExit(reason: string): void {
    this.qrChallenges.invalidate(this.socketGeneration);
    this.reportLifecycle("error");
    this.logger.log(
      `[${new Date().toISOString()}] ${reason}. Terminando el proceso para forzar un arranque limpio.`
    );
    this.emit("auth_failure", [
      reason,
      `Reintentos agotados; el proceso termina para que el supervisor lo reinicie`,
      `Check baileys.log for details`,
    ]);
    // Margen para que la linea llegue a stdout antes de morir.
    setTimeout(() => process.exit(1), 1000);
  }

  private shouldReconnect(statusCode: number): boolean {
    // Lista de códigos donde SÍ debemos reconectar
    const reconnectableCodes = [
      DisconnectReason.connectionClosed,
      DisconnectReason.connectionLost,
      DisconnectReason.connectionReplaced,
      DisconnectReason.timedOut,
      DisconnectReason.badSession,
      DisconnectReason.restartRequired,
      429, // Rate limited
      500, // Server error
      502, // Bad gateway
      503, // Service unavailable
      504, // Gateway timeout
    ];

    // El limite de intentos ya no vive aca: lo aplica `delayedReconnect`, que
    // es el unico que sabe cuantos van y cuanto lleva la racha. Mezclarlo aca
    // hacia que agotar los intentos cayera en el camino de "error critico".
    return reconnectableCodes.includes(statusCode);
  }

  private async delayedReconnect(): Promise<void> {
    if (this.lifecycleStopped) return;
    const now = Date.now();
    if (this.reconnectWindowStartedAt === null) {
      this.reconnectWindowStartedAt = now;
    }
    const elapsedMs = now - this.reconnectWindowStartedAt;

    // Sin sesion vinculada estamos en onboarding por QR: el socket cicla a
    // proposito mientras el QR rota y nadie escanea. Acotar los reintentos ahi
    // mataria el onboarding y dejaria el bot en loop de reinicios, asi que la
    // escalera con techo aplica SOLO cuando ya hay sesion.
    //
    // Esto reemplaza `patches/builderbot-provider-sherpa+0.1.6-beta.0.patch` del
    // consumidor, que subia `maxReconnectAttempts` a 100000 con el comentario
    // "QR no expira (onboarding)". Ese patch llevaba tiempo sin aplicar (se hizo
    // para 0.1.6-beta.0 y hoy se instala 0.1.7-beta.0), asi que la intencion
    // estaba escrita pero no surtia efecto. Aca queda en el codigo.
    const bounded = this.sessionWasRegistered;

    if (bounded && this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.giveUpAndExit(
        `Max reconnection attempts reached (${this.maxReconnectAttempts}) after ${Math.round(elapsedMs / 1000)}s`
      );
      return;
    }

    if (bounded && elapsedMs >= BaileysProvider.MAX_RECONNECT_WINDOW_MS) {
      this.giveUpAndExit(
        `Reconnect window exhausted (${Math.round(elapsedMs / 1000)}s) after ${this.reconnectAttempts} attempts`
      );
      return;
    }

    this.reconnectAttempts++;
    const backoff = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      BaileysProvider.MAX_RECONNECT_DELAY_MS
    );
    // Que el ultimo salto no se pase del techo de 15 min (solo si esta acotado).
    const delay = bounded
      ? Math.max(
        0,
        Math.min(backoff, BaileysProvider.MAX_RECONNECT_WINDOW_MS - elapsedMs)
      )
      : backoff;

    const budget = bounded ? `${this.maxReconnectAttempts}` : "sin limite (QR)";
    this.logger.log(
      `[${new Date().toISOString()}] Reconnection attempt ${this.reconnectAttempts
      }/${budget} in ${delay}ms (elapsed ${Math.round(elapsedMs / 1000)}s)`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.lifecycleStopped) return;
      try {
        this.initVendor().then((v) => this.listenOnEvents(v));
      } catch (error) {
        this.logger.log(
          `[${new Date().toISOString()}] Reconnection failed:`,
          error
        );
      }
    }, delay);
  }
}

export { BaileysProvider };
