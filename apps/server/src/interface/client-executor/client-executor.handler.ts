import { RavenContext, withSchema } from "@raven.js/core";

import { HubState } from "../../plugins/hub.plugin.js";
import { StoreState } from "../../plugins/store.plugin.js";
import { hashToken } from "../../secrets.js";
import { ClientExecutorSettingsContract } from "./client-executor.contract.js";

export const ClientExecutorSettingsHandler = withSchema(ClientExecutorSettingsContract.schemas, async ({ body }) => {
  const store = StoreState.getOrFailed();
  const hub = HubState.getOrFailed();
  const bearer = RavenContext.getOrFailed().request.headers.get("authorization") ?? "";
  const token = /^Bearer (\S{1,4096})$/.exec(bearer)?.[1];
  const accountId = token ? await store.accountForClientToken(hashToken(token), Date.now()) : undefined;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!accountId) return reply({ ok: false, error: "请先登录 Coflux" }, 401);

  const outcome = await hub.saveExecutorSettingsForAccount(accountId, {
    provider: body.provider,
    modelId: body.modelId,
    customProviders: body.customProviders,
    credentials: body.credentials,
  });
  return reply(outcome, outcome.ok ? 200 : 400);
});
