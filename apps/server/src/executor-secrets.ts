/**
 * executor 凭据的可逆加密（plan 20260918-executor-settings-central）。
 *
 * **这是中心安全模型的分水岭**：在此之前，中心持久化的每个秘密都是不可逆 hash
 * （`client_tokens.token_hash`、`users.password_hash`、`oauth_tokens.token_hash`），`apps/server/src`
 * 下找不到任何 `createCipheriv`。executor 的 API key 必须能还原后下发给设备，所以只能是可逆加密。
 * 任何新增的「中心存 X」都要先问 X 能不能只存 hash。
 *
 * 形态与轮换：
 * - AES-256-GCM，密文**自带 key-id 前缀**：`v1.<keyId>.<iv>.<tag>.<ciphertext>`（后三段 base64url）。
 * - `server.env` 里可以**同时配多把密钥**（当前一把 + 若干旧的）：解密按密文里的 key-id 选，加密一律
 *   用当前那把。这样轮换不需要停机重加密全表——只配一把、换钥匙就要整表迁移的方案，中途失败会留下
 *   一半读不出来的行。
 * - 密钥未配置时 `encrypt` 抛 {@link ExecutorSecretsUnavailableError}，调用方据此拒绝写入并返回可读
 *   错误，**绝不降级成明文落库**。
 * - 解密失败（key-id 不在配置里、密文被改）抛 {@link ExecutorSecretsUndecryptableError}，调用方要把它
 *   表达成一条可读错误交给桌面，不能表现成「没配过」——那会让用户以为自己从没填过 key。
 *
 * 环境变量 `COFLUX_EXECUTOR_KEYS`：逗号分隔的 `<keyId>:<base64 的 32 字节密钥>`，**第一项是当前密钥**。
 * 例：`COFLUX_EXECUTOR_KEYS=k2:<base64>,k1:<base64>`。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** key-id 只允许出现在密文前缀里，所以限制成不会与分隔符冲突的字符集。 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class ExecutorSecretsUnavailableError extends Error {
  constructor() {
    super("中心还没有配置 executor 凭据加密密钥（COFLUX_EXECUTOR_KEYS），拒绝以明文保存 API key；请联系部署方配置后重试");
    this.name = "ExecutorSecretsUnavailableError";
  }
}

export class ExecutorSecretsUndecryptableError extends Error {
  constructor(keyId: string) {
    super(`服务端密钥已变更，原先保存的 API key 无法读取（密钥 ${keyId}）：请重新填写 API key`);
    this.name = "ExecutorSecretsUndecryptableError";
  }
}

export type ExecutorSecretKey = { id: string; key: Buffer };

/**
 * 解析 `COFLUX_EXECUTOR_KEYS`。格式非法的项**整条拒绝**（抛错，启动即失败），而不是跳过：
 * 静默跳过一把旧密钥＝那批行永久读不出来，且没有任何人会注意到。
 */
export function parseExecutorSecretKeys(raw: string): ExecutorSecretKey[] {
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const keys: ExecutorSecretKey[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error(`COFLUX_EXECUTOR_KEYS 的项必须是 <keyId>:<base64 密钥>：${entry.slice(0, 16)}…`);
    const id = entry.slice(0, separator);
    if (!KEY_ID_PATTERN.test(id)) throw new Error(`COFLUX_EXECUTOR_KEYS 的 keyId 只能是字母、数字、_ 或 -，且不超过 32 字符：${id}`);
    if (seen.has(id)) throw new Error(`COFLUX_EXECUTOR_KEYS 出现重复的 keyId：${id}`);
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (key.length !== KEY_BYTES) throw new Error(`COFLUX_EXECUTOR_KEYS 的密钥 ${id} 必须是 base64 编码的 32 字节（AES-256）`);
    seen.add(id);
    keys.push({ id, key });
  }
  return keys;
}

export type ExecutorSecrets = {
  /** 是否至少配了一把密钥；false 时写凭据的请求必须被可读地拒绝。 */
  available(): boolean;
  /** 用**当前**密钥加密；未配置密钥时抛 ExecutorSecretsUnavailableError。 */
  encrypt(plaintext: string): string;
  /** 按密文自带的 key-id 选密钥；选不到或校验失败抛 ExecutorSecretsUndecryptableError。 */
  decrypt(ciphertext: string): string;
};

export function createExecutorSecrets(keys: readonly ExecutorSecretKey[]): ExecutorSecrets {
  const byId = new Map(keys.map((entry) => [entry.id, entry.key] as const));
  const current = keys[0];

  return {
    available: () => current !== undefined,
    encrypt(plaintext) {
      if (!current) throw new ExecutorSecretsUnavailableError();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current.key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, current.id, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
    },
    decrypt(ciphertext) {
      const parts = ciphertext.split(".");
      if (parts.length !== 5 || parts[0] !== VERSION) throw new ExecutorSecretsUndecryptableError("未知格式");
      const [, keyId, ivRaw, tagRaw, bodyRaw] = parts;
      const key = byId.get(keyId);
      if (!key) throw new ExecutorSecretsUndecryptableError(keyId);
      try {
        const iv = Buffer.from(ivRaw, "base64url");
        const tag = Buffer.from(tagRaw, "base64url");
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("iv/tag 长度不符");
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new ExecutorSecretsUndecryptableError(keyId);
      }
    },
  };
}
