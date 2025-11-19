import { Context, Service, Schema, Logger } from 'koishi'
import { connect, NatsConnection, ConnectionOptions, Authenticator, TlsOptions, nkeyAuthenticator } from 'nats'
import { schemaToConnectionOptions,Authen,TLS } from './schema-to-nats-connection'


export interface Config {
  servers: Array<string>;
  noRandomize?: boolean;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  authenticator?: Array<{
    authType: 'Token' | 'UserPass' | 'NKey' | 'creds_file';
    auth_token?: string;
    user?: string;
    pass?: string;
    nkey_seed?: string;
    creds_file?: string;
  }>;
  tlsEnabled?: boolean;
  tlsConfig?: {
    handshakeFirst?: boolean;
    certFile?: string;
    cert?: string;
    caFile?: string;
    ca?: string;
    keyFile?: string;
    key?: string;
  };
  name?: string;
  noAsyncTraces?: boolean;
  debug?: boolean;
}

export const Config =
  Schema.intersect([
    Schema.object({
      servers: Schema.array(String).role('table').default(["127.0.0.1:4222"]),
      noRandomize: Schema.boolean().default(false),
      reconnect: Schema.boolean().default(true),
    }).description("Connection"),
    Schema.union([
      Schema.object({
        reconnect: Schema.const(true),
        maxReconnectAttempts: Schema.number().default(-1),
      }),
      Schema.object({}),
    ]),
    Schema.object({
      authenticator: Schema.array(Authen),
      tlsEnabled: Schema.boolean().default(false),
    }).description("Security"),
    Schema.union([
      Schema.object({
        tlsEnabled: Schema.const(true).required(),
        tlsConfig: TLS
      }),
      Schema.object({}),
    ]),
    Schema.object({
      name: Schema.string().default("koishi-bot"),
      noAsyncTraces: Schema.boolean().default(false),
      debug: Schema.boolean().default(false),
    }).description("Miscellaneous"),

  ]).i18n({
    'zh-CN': require('./locales/zh-CN')._config,
    'en-US': require('./locales/en-US')._config,
  })

class NatsService extends Service {
  public client: NatsConnection | null = null;
  #l: Logger;
  constructor(ctx: Context, config: Config) {
    super(ctx, 'nats')
    this.config = config
    this.#l = ctx.logger(name)
  }

  async start() {
    if (this.client) {
      this.#l.warn('NATS client is already connected, no need to start again.')
      return
    }

    const connectOptions = await schemaToConnectionOptions(this.config)


    try {
      this.#l.info('Connecting to NATS server...')
      this.client = await connect(connectOptions)
      this.#l.success('Successfully connected to NATS server.')

      // Start an async task to monitor the connection status
      this.handleStatusUpdates(this.client)
    } catch (error) {
      this.#l.error('connect to NATS server Failed:', error)
      this.client = null
      throw error
    }
  }


  async stop() {
    if (this.client) {
      this.#l.info('Closing NATS connection...')
      // drain() ensures all pending messages are sent before closing
      await this.client.drain()
    }
  }

  private async handleStatusUpdates(client: NatsConnection) {
    try {
      const statusIterator = client.status()[Symbol.asyncIterator]()
      const closedPromise = client.closed()

      while (true) {
        const result = await Promise.race([
          statusIterator.next(),
          closedPromise.then((err) => ({ value: { type: 'closed', err }, done: true })),
        ])

        if (result.done) {
          // hit client.closed()
          const { err } = result.value as { type: 'closed', err: void | Error }
          if (err) {
            this.#l.error('NATS connection closed due to error:', err.message)
          } else {
            this.#l.info('NATS connection closed normally')
          }
          // TODO 断掉之后要不要由插件层面负责重连？
          this.client = null
          break
        }

        const status = result.value
        switch (status.type) {
          case 'error':
            this.#l.error('NATS error:', status.error || status.data)
            break
          case 'disconnect':
            this.#l.warn('Disconnected from NATS server')
            break
          case 'reconnect':
            this.#l.success('Reconnected successfully!')
            break
          case 'reconnecting':
            this.#l.info('Reconnecting...')
            break
          case 'staleConnection':
            this.#l.debug('NATS connection stale')
            break
          case 'ldm':
            this.#l.warn('Current NATS server entered lame duck mode')
            break
          case 'update':
            this.#l.debug('NATS cluster configuration updated:', status.data)
            break
          default:
            this.#l.debug(`NATS status update: ${status.type}`)
        }
      }
    } catch (err) {
      this.#l.error('NATS status listener exited abnormally:', err)
    }
  }
}

export const name = 'nats'

export const inject = ['logger']

export function apply(ctx: Context, config: Config) {
  ctx.plugin(NatsService,config)
}

// --- 模块增强 (TypeScript) ---
// 这是为了让 Koishi 的 Context 类型知道 'nats' 服务的存在
declare module 'koishi' {
  interface Context {
    nats: NatsService
  }
}
