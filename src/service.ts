import { Context, Service, Schema, Logger } from 'koishi'
import { connect, NatsConnection, ConnectionOptions } from 'nats'


export interface Config {
  servers: Array<string>;
  options?: Omit<ConnectionOptions, 'servers'>;
}

export const Config = Schema.object({
  servers: Schema.array(String).description('NATS 服务器 URL').required().default(["127.0.0.1:4222"]),
  options: Schema.object({}).description('NATS 连接选项').default({}),
})

export class NatsService extends Service {
  public client: NatsConnection | null = null;
  #l: Logger;

  constructor(ctx: Context, config: Config) {
    // 'nats' 是服务名称，之后可通过 ctx.nats 访问
    // 调用 super 会自动通过 ctx.reflect.provide 将服务注册到上下文中
    super(ctx, 'nats')
    this.#l = ctx.logger(name)
  }

  async start() {
    if (this.client) {
      this.#l.warn('NATS 客户端已连接，无需重复启动。')
      return
    }

    const connectOptions: ConnectionOptions = {
      servers: this.config.servers,
      ...this.config.options,
    }

    try {
      this.#l.info(`正在连接到 NATS 服务器: ${this.config.servers}`)
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
      this.#l.info('正在断开 NATS 连接...')
      // drain() 会确保所有待处理消息发送完毕再关闭
      await this.client.drain()

      this.client = null
      this.#l.success('已安全断开 NATS 连接。')
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