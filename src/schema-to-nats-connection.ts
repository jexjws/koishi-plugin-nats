import { ConnectionOptions, TlsOptions, tokenAuthenticator, usernamePasswordAuthenticator, nkeyAuthenticator, credsAuthenticator } from 'nats'
import type { Config } from './service'
import { Schema } from 'koishi'
import { readFile } from 'fs/promises'


export const Authen = Schema.intersect([
  Schema.object({
    authType: Schema.union(['Token', 'UserPass', 'NKey', 'creds_file']).role('radio').required().description('https://docs.nats.io/using-nats/developer/connecting#authentication-details'),
  }),
  Schema.union([
    Schema.object({
      authType: Schema.const('Token').required(),
      auth_token: Schema.string().role('secret').required().description('https://docs.nats.io/using-nats/developer/connecting/token'),
    }),
    Schema.object({
      authType: Schema.const('UserPass').required(),
      user: Schema.string().required().description('https://docs.nats.io/using-nats/developer/connecting/userpass'),
      pass: Schema.string().role('secret')
    }),
    Schema.object({
      authType: Schema.const('NKey').required(),
      nkey_seed: Schema.string().role('secret').required().description('https://docs.nats.io/using-nats/developer/connecting/nkey'),
    }),
    Schema.object({
      authType: Schema.const('creds_file').required(),
      creds_file: Schema.path().required().description('https://docs.nats.io/using-nats/developer/connecting/creds')
    })
  ]),
])

export const TLS = Schema.object({
  handshakeFirst: Schema.boolean().required(),
  certFile: Schema.path(),
  cert: Schema.string().role('textarea'),
  caFile: Schema.path(),
  ca: Schema.string().role('textarea'),
  keyFile: Schema.path(),
  key: Schema.string().role('textarea'),
}).description("TLS Configuration")


/**
 * 将 koishi 的配置构型 转换为 NATS ConnectionOptions
 * @param config Schema 配置对象
 * @returns NATS 连接选项
 */
export async function schemaToConnectionOptions(config: Config): Promise<ConnectionOptions> {
  // console.log(config);
  const options: ConnectionOptions = {
    servers: config.servers,
    noRandomize: config.noRandomize,
    reconnect: config.reconnect,
    maxReconnectAttempts: config.maxReconnectAttempts,
    name: config.name,
    noAsyncTraces: config.noAsyncTraces,
    debug: config.debug,
  };

  // 处理认证器配置
  if (config.authenticator && config.authenticator.length > 0) {
    const authenticators = await Promise.all(config.authenticator.map(async (auth) => {
      switch (auth.authType) {
        case 'Token':
          return tokenAuthenticator(auth.auth_token);
        case 'UserPass':
          return usernamePasswordAuthenticator(auth.user, auth.pass);
        case 'NKey':
          const seed = new TextEncoder().encode(auth.nkey_seed);
          return nkeyAuthenticator(seed);
        case 'creds_file':
          const credsContent = await readFile(auth.creds_file);
          return credsAuthenticator(credsContent);
      }
    }));
    options.authenticator = authenticators;
  }

  // 处理 TLS 配置
  if (config.tlsEnabled) {
    const tlsOptions: TlsOptions = {};
    tlsOptions.handshakeFirst = config.tlsConfig.handshakeFirst;

    if (config.tlsConfig.certFile) {
      tlsOptions.certFile = await readFile(config.tlsConfig.certFile, 'utf8');
    }
    tlsOptions.cert = config.tlsConfig.cert;

    if (config.tlsConfig.keyFile) {
      tlsOptions.keyFile = await readFile(config.tlsConfig.keyFile, 'utf8');
    }
    tlsOptions.key = config.tlsConfig.key;

    if (config.tlsConfig.caFile) {
      tlsOptions.caFile = await readFile(config.tlsConfig.caFile, 'utf8');
    }
    tlsOptions.ca = config.tlsConfig.ca;

    options.tls = tlsOptions;
  }

  return options;
}
