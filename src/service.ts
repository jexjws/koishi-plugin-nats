import { Context, Service, Schema, Logger } from 'koishi'
// 导入 NATS 客户端库
import { connect, NatsConnection, ConnectionOptions } from 'nats'

// --- 1. 定义配置 (Config) ---
// 这对应 Service 中的 [symbols.config] 概念
export interface Config {
  servers: Array<string>;
  options?: Omit<ConnectionOptions, 'servers'>;
}

export const Config = Schema.object({
  servers: Schema.array(String).description('NATS 服务器 URL').required().default(["127.0.0.1:4222"]),
  options: Schema.object({}).description('NATS 连接选项').default({}),
})

// --- 2. 定义 NatsService ---
// 继承 Service 类
export class NatsService extends Service {
  public client: NatsConnection | null = null;

  // 参考 service.ts 的构造函数
  // 传入 ctx 和 config
  constructor(ctx: Context, config: Config) {
    // 'nats' 是服务名称，之后可通过 ctx.nats 访问
    // 调用 super 会自动通过 ctx.reflect.provide 将服务注册到上下文中
    super(ctx, 'nats')
  }

  /**
   * 启动服务：连接到 NATS 服务器
   */
  async start() {
    if (this.client) {
      this.ctx.logger.warn('NATS 客户端已连接，无需重复启动。')
      return
    }

    const connectOptions: ConnectionOptions = {
      servers: this.config.servers,
      ...this.config.options,
    }

    try {
      this.ctx.logger.info(`正在连接到 NATS 服务器: ${this.config.servers}`)
      this.client = await connect(connectOptions)
      this.ctx.logger.info('成功连接到 NATS 服务器。')

      // 启动一个异步任务来监听 NATS 状态
      this.handleStatusUpdates(this.client)
    } catch (error) {
      this.ctx.logger.error('连接 NATS 服务器失败:', error)
      this.client = null
    }
  }

  /**
   * 停止服务：断开 NATS 连接
   */
  async destroy() {
    if (this.client) {
      this.ctx.logger.info('正在断开 NATS 连接...')
      // drain() 会确保所有待处理消息发送完毕再关闭
      await this.client.drain()

      this.client = null
      this.ctx.logger.info('已安全断开 NATS 连接。')
    }
  }

  /**
   * 监听 NATS 客户端状态变化
   */
  private async handleStatusUpdates(client: NatsConnection) {
    try {
      for await (const status of client.status()) {
        switch (status.type) {
          case 'error':
            this.ctx.logger.error('NATS 发生错误:', status.data)
            break
          case 'disconnect':
            this.ctx.logger.warn('NATS 连接已断开。')
            break
          case 'reconnect':
            this.ctx.logger.info('NATS 正在重新连接...')
            break
          default:
            this.ctx.logger.debug(`NATS 状态更新: ${status.type}`, status.data)
        }
      }
    } catch (err) {
      this.ctx.logger.error('NATS 状态监听器异常退出:', err)
    }
  }

  /**
   * (可选) 封装 NATS 的核心方法
   * 确保在使用前检查客户端是否连接
   */
  
  /**
   * 发布消息
   * @param subject 主题
   * @param data 消息数据
   */
  publish(subject: string, data?: Uint8Array) {
    if (!this.client) {
      this.ctx.logger.warn('NATS 未连接，无法发布消息。')
      return
    }
    this.client.publish(subject, data)
  }

  /**
   * 订阅主题
   * @param subject 主题
   * @param callback 回调函数
   * @returns NATS Subscription 对象
   */
  subscribe(subject: string, callback: (data: Uint8Array, subject: string) => void) {
    if (!this.client) {
      this.ctx.logger.warn('NATS 未连接，无法订阅。')
      return
    }
    
    const sub = this.client.subscribe(subject)
    ;(async () => {
      for await (const msg of sub) {
        callback(msg.data, msg.subject)
      }
    })().catch(err => {
      this.ctx.logger.error(`订阅 ${subject} 时出错:`, err)
    })
    
    this.ctx.logger.debug(`已订阅主题: ${subject}`)
    return sub
  }

  /**
   * 请求-响应 模式
   * @param subject 主题
   * @param data 请求数据
   * @param timeout 超时时间 (毫秒)
   * @returns 响应消息
   */
  async request(subject: string, data?: Uint8Array, timeout: number = 5000) {
    if (!this.client) {
      this.ctx.logger.warn('NATS 未连接，无法发送请求。')
      return null
    }
    try {
      return await this.client.request(subject, data, { timeout })
    } catch (err) {
      this.ctx.logger.error(`请求 ${subject} 失败:`, err)
      return null
    }
  }
}

// --- 3. 插件入口 (apply) ---
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
    await natsService.destroy()
  })
}

// --- 模块增强 (TypeScript) ---
// 这是为了让 Koishi 的 Context 类型知道 'nats' 服务的存在
declare module 'koishi' {
  interface Context {
    nats: NatsService
  }
}