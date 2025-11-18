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
      servers: Schema.array(String).description('NATS 服务器 URL').role('table').default(["127.0.0.1:4222"]),
      noRandomize: Schema.boolean().description('若启用，在实例化连接时，客户端在内部就**不会**打乱servers列表的顺序、也**不会**打乱 对服务器主机名DNS解析出的IP地址列表 的顺序。关闭此选项可实现多个服务器的负载均衡，避免总是优先连接第一个可用服务器').default(false),
      reconnect: Schema.boolean().description('客户端断连后，主动发起重连').default(true),
    }).description("连接"),
    Schema.union([
      Schema.object({
        reconnect: Schema.const(true),
        maxReconnectAttempts: Schema.number().description("对每个 服务器 的最大重连尝试次数，设置为 -1 表示永不放弃重连").default(-1),
      }),
      Schema.object({}),
    ]),
    Schema.object({
      authenticator: Schema.array(Authen).description('客户端认证方案。当服务器要求认证时，将使用这里的认证方案。'),
      tlsEnabled: Schema.boolean().description('TLS 可加密客户端与服务器之间的通信，并验证服务器的身份。').default(false),
    }).description("安全"),
    Schema.union([
      Schema.object({
        tlsEnabled: Schema.const(true).required(),
        tlsConfig: TLS.required()
      }),
      Schema.object({}),
    ]),
    Schema.object({
      name: Schema.string().description('客户端名称。设置后，NATS 服务器监控页面在提及此客户端时将显示此名称。').default("koishi-bot"),
      noAsyncTraces: Schema.boolean().description('When `true` the client will not add additional context to errors associated with request operations. Setting this option to `true` will greatly improve performance of request/reply and JetStream publishers.').default(false),
      debug: Schema.boolean().description('设置为 `true` 时，客户端将使用 javascript console 对象（不是 [koishi Logger](https://koishi.chat/zh-CN/api/utils/logger.html)）打印它接收或发送到服务器的协议消息。').default(false),
    }).description("杂项"),

  ])

class NatsService extends Service {
  public client: NatsConnection | null = null;
  #l: Logger;
  constructor(ctx: Context, config: Config) {
    // 'nats' 是服务名称，之后可通过 ctx.nats 访问
    // 调用 super 会自动通过 ctx.reflect.provide 将服务注册到上下文中
    super()
    this.config = config
    this.#l = ctx.logger(name)
  }

  async start() {
    if (this.client) {
      this.#l.warn('NATS 客户端已连接，无需重复启动。')
      return
    }

    const connectOptions = await schemaToConnectionOptions(this.config)


    try {
      this.#l.info(`正在连接到 NATS 服务器...`)
      this.client = await connect(connectOptions)
      this.#l.success('成功连接到 NATS 服务器。')

      // 起一个异步任务来监听 本次连接的 状态
      this.handleStatusUpdates(this.client)
    } catch (error) {
      this.#l.error('连接 NATS 服务器失败:', error)
      this.client = null
    }
  }


  async stop() {
    if (this.client) {
      this.#l.info('关闭 NATS 连接...')
      // drain() 会确保所有待处理消息发送完毕再关闭
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
          // 命中 client.closed()
          const { err } = result.value as { type: 'closed', err: void | Error }
          if (err) {
            this.#l.error('NATS 连接因错误而关闭:', err.message)
          } else {
            this.#l.info('NATS 连接已正常关闭')
          }
          this.client = null
          break
        }

        const status = result.value
        switch (status.type) {
          case 'error':
            this.#l.error('NATS 出错:', status.error || status.data)
            break
          case 'disconnect':
            this.#l.warn('已断开与 NATS 服务器的连接')
            break
          case 'reconnect':
            this.#l.success('重连成功！')
            break
          case 'reconnecting':
            this.#l.info('正在重连...')
            break
          case 'staleConnection':
            this.#l.debug('NATS 连接陈旧')
            break
          case 'ldm':
            this.#l.warn('当前 NATS 服务器进入 跛脚鸭模式')
            break
          case 'update':
            this.#l.debug('NATS 集群配置更新:', status.data)
            break
          default:
            this.#l.debug(`NATS 状态更新: ${status.type}`)
        }
      }
    } catch (err) {
      this.#l.error('NATS 状态监听器异常退出:', err)
    }
  }
}

export const name = 'nats'

export const inject = ['logger']

export function apply(ctx: Context, config: Config) {
  // 1. 实例化服务。
  // 在 Service 的构造函数中，
  // 插件会自动调用 ctx.reflect.provide('nats', ...) 将自身注册到上下文中。
  const natsService = new NatsService(ctx, config)

  ctx.on('ready', async () => {
    // ctx.logger.error(config)
    await natsService.start()
  })

  ctx.on('dispose', async () => {
    await natsService.stop()
  })
}

// --- 模块增强 (TypeScript) ---
// 这是为了让 Koishi 的 Context 类型知道 'nats' 服务的存在
declare module 'koishi' {
  interface Context {
    nats: NatsService
  }
}
