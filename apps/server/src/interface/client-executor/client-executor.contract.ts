/**
 * executor 模型配置的写入口（plan 20260918-executor-settings-central）。
 *
 * **只有写，没有读**：读路径是「中心 → daemon 链路下发 → daemon 本机缓存文件 → 桌面主进程读文件」，
 * 全程不出本机，断网时 executor 照常能发任务。加一个 HTTP 读口就等于给自己留了一条联网才能读配置的
 * 路，迟早会被用上，然后断网就废。
 *
 * 独立于 `/api/client/command`：那条路经桌面的 local broker 转发给同机 CLI，配置写入不该顺带长在
 * 那个面上。这里只服务桌面主进程。
 */
import { defineContract } from "@raven.js/core/contract";
import { z } from "zod";

import { EXECUTOR_CUSTOM_APIS, MAX_EXECUTOR_CREDENTIAL_BYTES, MAX_EXECUTOR_CUSTOM_MODELS, MAX_EXECUTOR_CUSTOM_PROVIDERS } from "../../executor-settings.js";

const providerId = z.string().min(1).max(128);

const customProvider = z
  .object({
    id: providerId,
    name: z.string().max(256).default(""),
    baseUrl: z.string().max(2048).default(""),
    api: z.enum(EXECUTOR_CUSTOM_APIS),
    models: z
      .array(z.object({ id: z.string().min(1).max(256), name: z.string().max(256).default("") }).strict())
      .max(MAX_EXECUTOR_CUSTOM_MODELS)
      .default([]),
    authHeader: z.boolean().default(false),
    keyless: z.boolean().default(false),
  })
  .strict();

export const ClientExecutorSettingsContract = defineContract({
  method: "POST",
  path: "/api/client/executor-settings",
  schemas: {
    body: z
      .object({
        protocolVersion: z.literal(1),
        provider: z.string().max(128).optional(),
        modelId: z.string().max(256).optional(),
        customProviders: z.array(customProvider).max(MAX_EXECUTOR_CUSTOM_PROVIDERS).optional(),
        /** providerId -> API key。空串 = 清除；缺席 = 不改动（凭据是只写的，中心从不回显）。 */
        credentials: z.record(providerId, z.string().max(MAX_EXECUTOR_CREDENTIAL_BYTES)).optional(),
      })
      .strict(),
  },
});
