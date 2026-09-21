# Plan 20260918-executor-settings-central: executor 的模型配置改由中心持有，设置页做成配得出来的样子

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 392387f4..HEAD -- apps/server/src apps/desktop/src proto/coflux/v1 crates/worker/src`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check（2026-09-19 用户重选，覆盖 09-18 记录的 fable）
- Stop after: implementation — departure check（autopilot item 选了 advisor review）
- Plan review: advisor — departure check；2026-09-19 已执行，12 条发现全部采纳或归位（读写链路、凭据形态、pi 的 config-value 执行面、可空主键、协议验证命令等），详见各条 `(revised on advisor review)` 标记
- Workspace: isolated — 从 main 主工作区切出 `dev/20260918-executor-settings-central`
- Planned at: `392387f4`, 2026-09-18

> **Where this plan sits in what came after (added 2026-09-21)**: by moving credential persistence out of the desktop's `safeStorage` and into the 0600 cache file the daemon writes, this plan **reversed evidence (3) of decision D1 in [20260912-executor-engine](20260912-executor-engine.md)** ("provider credentials live only in desktop safeStorage, which a daemon-side runner cannot read"). [20260921-executor-daemon-host](20260921-executor-daemon-host.md) builds directly on that: the executor became an npm package the daemon can host, and its host reads exactly the cache file defined here — no second credential-distribution path was built. Everything this plan records about the read/write split, the cache file's shape and the memory-only credentials in both runtimes still holds; the only change is that the long-lived main-process `ModelRuntime` now comes from `@coflux/executor`, one implementation shared by both hosts.

## Requirement

### 问题

executor（`coflux executor run`，把一个边界清楚的子任务甩给桌面 app 内置的 pi agent）的模型配置现在是三个自由文本框：provider、modelId、apiKey。用户必须手打 provider id 和 model id，打错了不会当场报错——`deriveReadiness` 只校验三者非空（`apps/desktop/src/main/executor-config.ts:92`），真正的验证要等 agent 发任务时 `getModel()` 返回 undefined，才报一句「桌面配置里的模型不可用」。不能用订阅、不能配自定义端点、配完无法验证。

根因是结构性的，不是 UI 偷懒：`ModelRuntime` 只在 runner 子进程里创建，配置目录是「一次任务一个临时 scratch dir，跑完就删」（`apps/desktop/src/main/executor-runner.ts:22-30` 的第 5 条集成决策）。主进程手上从头到尾只有三个字符串，从没创建过 `ModelRuntime`，所以没有任何地方能列模型、能发起登录、能校验；需要持久化的凭据也无处可存。

### 完成后为真

1. **配置跟账号走，不跟机器走。** 中心 `executor_settings` 表是真相源，经 daemon 链路下发到设备，daemon 落成本机缓存文件，桌面主进程直接读它；改配置时主进程经 HTTPS 写中心。换机器、重装 app，配置还在。
2. **读路径永远不出本机。** 断网时 executor 照常能发任务（读 daemon 的本地缓存）；只有*修改*配置需要在线。这条不是性能优化，是项目既定的 local-first 纪律。
3. **配置是选出来的，不是打出来的。** provider 从内置目录里选，模型可搜索，保存时当场校验，还能真发一次请求确认联通。
4. **自定义端点可用。** 中转站、Ollama、任何 OpenAI/Anthropic/Google 兼容的端点都能加，加完直接出现在 provider 选择里。

### 产品结论（exploration 已与用户确认，不要重新设计）

设置页 Executor 分区的结构：

```
状态
  ● 已就绪 / ○ 未就绪 + 可操作的原因
  怎么用：agent 在终端里 coflux executor run 发起
  生效范围：此配置对账号下所有设备生效

模型
  Provider  [ 下拉：40 个内置 + 用户添加的自定义端点，同一个列表 ]
  模型      [ 可搜索：输 sonnet 直接出 anthropic/claude-sonnet-5，跨 provider 搜 ]
            选中项显示上下文窗口与价格
  API key   [ 只写：不回显、留空=不改动 ]  [清除]

  [ 保存 ]  [ 测试连接 ]
  ✓ 已校验：凭据形式正确        ← 保存的结果，不花钱
  ✓ 已联通：12 token · 840ms    ← 测试连接的结果，真发一次请求

自定义端点
  ▸ my-relay   https://xxx/v1   openai-completions   [编辑]
  [ + 添加 ]
```

- **自定义端点添加后直接进 provider 下拉**，不做并列的第二套选择。对 pi 来说自定义端点本来就是一个 provider，分两处选会让「我在用哪个」变模糊。
- **模型选择必须可搜索**：openrouter 有 366 个模型、vercel-ai-gateway 有 237 个，纯下拉翻不动。
- **保存与测试连接是两个动作**：保存只做不花钱的校验（provider 存在、模型存在、凭据形式正确），测试连接才真发一次最小请求并回报 token 数与延迟。
- **离线时能看能用不能改**：读走本机缓存所以 executor 照常发任务，修改配置的控件置灰并说明原因。
- **凭据只写**：不回显、留空表示不改动、清除是单独按钮。理由见 `apps/desktop/src/main/../renderer/components/settings/executor-section.tsx:14` 的既有注释——画一排假圆点会让用户把假值当成自己的 key，一次误覆盖就找不回来。

消费者能观察到的验收：打开设置页 → 从下拉里选 Anthropic → 搜 sonnet 选中 claude-sonnet-5 → 粘贴 key → 保存看到「已校验」→ 点测试连接看到 token 数与延迟 → 在终端 `coflux executor run --prompt="..."` 能跑起来。

## Decisions & tradeoffs

- **配置的真相源**：中心 `executor_settings` 表。读路径是「中心 → daemon 链路下发 → daemon 本地缓存 → 桌面主进程读缓存」。Rejected: 中心为唯一来源、读时联网 —— 断网就发不了 executor 任务，违背项目既定的 local-first 纪律（本地能闭环的 agent 操作绝不经中心）。Based on: 协议分工 `proto/coflux/v1/daemon.proto:1`（daemon⟷server）与 `proto/coflux/v1/device.proto:1`（client⟷worker）。

- **读写走两条不同的路，且都不经渲染层**（revised on advisor review）：**读 = 主进程直接读 daemon 落在 `$COFLUX_HOME` 下的缓存文件**（见下一条的形态约定），不经任何 IPC、不经渲染层、不联网；**写 = 主进程直接 HTTPS 请求中心**，复用 app 已持有的账号 token，中心落库后经既有 daemon 链路下发、daemon 重写缓存文件。Rejected: 配置读写经 device 通道 —— 主进程**没有**到本机 daemon 的 device 通道，executor 现有的 register/report 帧是「主进程 → IPC → 渲染层 → `@coflux/client` → daemon」（`apps/desktop/src/main/executor-host.ts:63` 的 `send` 只会 `sendToRenderer`；`apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:6-17` 自述为「a messenger and nothing more」；`apps/desktop/src/main` 下搜不到 `@coflux/client`），沿用它就等于让凭据穿过渲染层，直接踩破本 plan 自己的约束。Rejected: 为此在主进程新建一条 loopback device 通道 —— 要在主进程引入协议客户端并满足 daemon 的 loopback 判定，成本远高于读一个文件，而本需求并不需要主进程具备完整 device 能力。Rejected: 读也走主进程 HTTPS 直连中心 —— 断网即失效，违背上一条。**约束**：渲染层在整条链路上只被允许知道「配没配成、ready 与否、错误原因」，绝不允许看到凭据的任何形态（明文或密文）。

- **daemon 缓存文件的形态**（revised on advisor review）：落在 `$COFLUX_HOME` 下、权限 `0600`、**明文 JSON**、写入用「临时文件 + rename」保证原子性。其威胁模型与既有的 `credentials.json` 完全相同——那里已经以同样方式存着 device_token 这个 bearer 秘密，见 `crates/worker/src/creds.rs:1`。主进程只读不写；感知变更用文件监听或轮询，不新增 IPC 面。Rejected: 参照 `crates/worker/src/conn_state.rs:1-10` 的落盘范式 —— 该文件顶部原文写明「纯本地快照文件，不含密钥，无需 0600」，正是**不该**用来放凭据的那一个。Rejected: 缓存里存中心密文 —— 解密密钥在 `server.env`，daemon 与桌面谁都解不开，缓存将毫无用处。

- **凭据也进中心，并且中心首次引入可逆加密**：API key 以 AES-256-GCM 密文存库，密钥从 `server.env` 读取，**密钥未配置时拒绝写入凭据并返回可读错误**，绝不降级成明文落库。Rejected: 凭据留本机、只同步非敏感配置 —— 用户明确要求「登录即得、服务器上不必 ssh 上去填 key」。Rejected: 端到端加密（用户密码派生密钥）—— executor 以后要在无人值守的设备上跑，解密需要用户交互就不成立。**注意这是中心安全模型的实质变更**：至今中心存的每个秘密都是不可逆 hash（`apps/server/src/infra/database/schema-migrations.ts:167` `client_tokens.token_hash`、`:176` `users.password_hash`、`:763` `oauth_tokens.token_hash`），`apps/server/src` 下搜不到任何 `createCipheriv`。**密钥轮换定死为 key-id 方案**（revised on advisor review）：密文自带 key-id 前缀，`server.env` 允许同时配多把密钥（当前一把 + 若干旧的），解密时按 key-id 选，加密一律用当前那把。Rejected: 只配一把、轮换时全表重加密 —— 需要一次性停机迁移，且中途失败会留下一半读不出来的行。Rejected: 只写「要有可执行路径」而不定死 —— 这种措辞会被实现成「换了密钥旧数据就读不出来，让用户重填」，那是让用户配置静默失效。**解密失败要给桌面一条可读错误**（例如「服务端密钥变更，请重新填写 API key」），不能表现成 `ready=false` 或空配置——那会让用户以为自己没配过。Based on: 用户在 departure check 明确接受该攻击面。

- **表按 `(account_id, device_id)` 唯一，`device_id` 可空且 NULL 行表示账号级默认**：读取时先找本设备行、没有则回退 NULL 行。本版 UI 只写 NULL 行，不提供设备级覆盖入口。**注意不能写成 `PRIMARY KEY (account_id, device_id)`**（revised on advisor review）：Postgres 的主键列隐含 `NOT NULL`，可空的 `device_id` 进不了主键。用代理主键 + `UNIQUE NULLS NOT DISTINCT (account_id, device_id)`（PG15+，生产是 PG17）。Rejected: 用空串代替 NULL 表示账号级 —— 那是把「没有设备」编码成一个合法 device_id，以后设备覆盖的回退查询要处处特判。Rejected: 主键只有 `account_id` —— 用户拓扑跨境（国内设备可能必须走中转站、prod-jp 能直连），以后要设备差异化就得改主键 + 数据迁移；现在留位的成本是一列。约束：本版**不得**因为留了位就顺手把设备覆盖的 UI 也做了——那是下一版的事。

- **主进程持有一个长期 `ModelRuntime`，配置目录持久化**：目录落在 app 的 userData 下，作为中心配置的本机物化产物 + pi 运行所需的工作目录。Rejected: 继续每任务一个临时目录 —— 那样主进程永远无法列模型、校验、持久化凭据，正是本需求要解决的根因。**但与用户自己 `~/.pi` 的隔离一条都不能松**：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 仍必须在加载 pi 之前设好，`ModelRuntime.create` 的 `authPath` / `modelsPath` / `modelsStorePath` 仍必须显式指向 coflux 自己的目录。「持久化」改的是目录的生命周期，不是隔离边界。Based on: `apps/desktop/src/main/executor-runner.ts:160-200` 记录的隔离理由——不隔离会让 executor 无声使用用户自己的订阅凭据，且模型集合随用户的 models.json 变得不可预测。

- **runner 的五条 pi 集成决策全部保留**：closed ResourceLoader（`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`）、inline guard extension、替换掉的 bash 后端（sandbox-exec + 按进程组 kill）、`SessionManager.inMemory()`、私有 pi 配置。本需求只改配置从哪来，不改 executor 跑起来之后的任何边界。Based on: `apps/desktop/src/main/executor-runner.ts:14-30`。

- **两个进程里的 `ModelRuntime` 都只用内存凭据，绝不给任何会写盘的 credential store**（revised on advisor review）：主进程那个长期 runtime 与 runner 子进程那个临时 runtime，凭据都经 `setRuntimeApiKey()` 或内存实现的 `CredentialStore` 注入。Rejected: 用 safeStorage 加密的 `CredentialStore` 做持久化 —— 凭据的持久化职责已经归 daemon 缓存文件（见上），桌面再存一份就是同一块磁盘上的第二份副本，且 safeStorage 密文旁边就躺着 daemon 的 0600 明文，加密纯属装饰。Rejected: 让 pi 自己写 `auth.json` —— 那是磁盘上第三份。**注意「不落 auth.json」在现状下本就成立**：`setRuntimeApiKey` 是内存 overlay，从不写 `authPath`（pi 包 `dist/core/runtime-credentials.js:17-20`、`dist/core/model-runtime.js:394-400`）；只有实现者主动换成会写盘的 store 才会冒出 auth.json。Based on: `CreateModelRuntimeOptions.credentials` 见 pi 包 `dist/core/model-runtime.d.ts:4`。

- **runner 子进程的凭据仍由 start 消息传入，不改成「runner 自己去读配置」**（revised on advisor review）：`executor-runner-protocol.ts` 的 `ExecutorRunnerStart` 保留 `apiKey` 及模型字段，主进程读完 daemon 缓存后随 start 消息下发。Rejected: runner 自行读缓存文件或自行解密 —— runner 是 `utilityProcess.fork` 出来的（`apps/desktop/src/main/executor-host.ts:170`），Electron 的 `Utility` 命名空间只暴露 `net / parentPort / systemPreferences`，**没有 `safeStorage`**；让它自己去读那份 0600 明文缓存，等于在第二个进程里再开一个凭据入口，白白扩大暴露面。既有的「safeStorage → 主进程内存 → start 消息」单向流（`apps/desktop/src/main/executor-config.ts:1-17`）本次只换掉最前面的来源，不换流向。

- **自定义端点的定义必须同时送进 runner 的那个 `ModelRuntime`**（revised on advisor review）：主进程 `registerProvider()` 注入的自定义 provider，runner 子进程一无所知——它在自己的进程里另建 runtime（`apps/desktop/src/main/executor-runner.ts:204`），而现有 `ExecutorRunnerStart` 只带 `model: {provider, id}` 与 `apiKey`。start 消息要加上自定义端点的定义块，runner 启动时同样 `registerProvider()`，否则「能在设置页选到它」和「用它真能跑起来」是两回事。

- **自定义端点经 `ModelRuntime.registerProvider()` 运行时注入**，不读也不写用户的 `~/.pi/models.json`。Rejected: 生成 models.json 文件交给 pi 读 —— 会把 coflux 的配置面绑死在 pi 的完整文件 schema 上，且容易与「不碰用户 ~/.pi」的边界混淆。中心只存 UI 暴露的那几个字段（名称、baseUrl、api 类型、模型定义、兼容开关），落到本机时组装。

- **凭据绝不经 `registerProvider()` 的 `apiKey` / `headers` 传入，只经 `setRuntimeApiKey()` 或内存 `CredentialStore`**（revised on advisor review）。**这是安全约束，不是风格偏好**：pi 把这两个字段当「config value」解析——值以 `!` 开头会被当成 shell 命令**执行**并取 stdout，以 `$` 开头会读环境变量（`dist/core/resolve-config-value.js:66,134,161`；`registerProvider` 的入口在 `dist/core/provider-composer.js:216-241` 调 `resolveConfigValueOrThrow`）。而本需求之后，凭据来自中心且是**账号级共享**的（`users` 表里多个用户共用一个 `account_id`，见 `apps/server/src/infra/database/schema-migrations.ts:185-188`），于是任何能改账号配置的人，写一个 `!curl … | sh` 形态的「API key」，就能在该账号下每一台桌面的**主进程**里执行任意命令。走 `setRuntimeApiKey` / 自实现 `CredentialStore` 的值则原样返回、不经 resolve（`dist/core/runtime-credentials.js:20`）。保存时顺手拒绝 `!` 与 `$` 开头的 key 可以做，但防线必须是「不走 resolve 的那条路」，不能只靠输入校验。同理，Ollama 这类 keyless 本地服务需要的占位 key 也走 `CredentialStore` 填，不要图省事写进 `registerProvider({apiKey})`。

- **自定义模型的元数据要有明确的占位策略，且 UI 必须说实话**（revised on advisor review）：`registerProvider` 的 `models[]` 不是「模型 id 列表」——每个条目必填 `name / reasoning / input / cost / contextWindow / maxTokens`（`dist/core/provider-composer.d.ts:25-39`）。实现者必须为手填的自定义模型编出这些值，所以在此定死：`contextWindow` 128000、`maxTokens` 8192、`cost` 四项全 0、`reasoning` false、`input` `["text"]`，且**设置页对自定义模型显示「未知」而不是把这些占位数当真实规格展示**——M5 要求「选中项显示上下文窗口与价格」，那是对内置目录模型而言的。api 类型本版暴露四个：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`（pi 的 `KnownApi` 共十个，其余不暴露）。

- **凭据的数据形态要能容纳 OAuth，但本版只实现 api_key 分支**：字段设计对齐 pi 的 `Credential` 联合类型（`api_key` | `oauth`）。Rejected: 本版就做 OAuth 订阅登录 —— 用户明确留到下一版。约束：本版**不得**出现 OAuth 登录入口或半成品 UI。

- **模型校验只在本机做**：中心没有 pi，也不该有。保存时的校验与「测试连接」都由桌面主进程的 `ModelRuntime` 执行，中心只存不判断。

- **主进程的长期 `ModelRuntime` 用 `allowModelNetwork: false`**（decided while planning）：模型目录只用 pi 内置的那份 + `models-store.json` 缓存。实测 `allowModelNetwork: false` 下 `getProviders()` 依然返回 40 个 provider、上千模型且元数据齐全，两级选择要的东西一样不缺。Rejected: 开 `true` 换取更新的模型目录 —— 那会让主进程在用户没发起任何动作时主动联外网拉目录，是一条新的出网行为，且失败模式（超时、被墙）会拖住设置页。「测试连接」是用户显式点击的一次请求，与此无关，照做。

- **`ready` 仍由桌面上报给 daemon**：`DeviceExecutorHostRegister.ready` / `not_ready_reason` 的语义不变，变的只是桌面判断 ready 时读的配置来源。Rejected: 让 daemon 自己根据缓存判断 ready —— 判断需要知道 provider/模型是否真的存在，那是 pi 的知识。Based on: `proto/coflux/v1/device.proto:676-684`。

- **host 重连不补报的 bug 一并修掉**（decided while planning，属于本需求的完成度）：`setChannel(daemonId)` 在 `daemonId` 未变化时直接 return，所以 device 通道断开重连后桌面不会重新 register，daemon 侧 host 记录为空，agent 侧表现为「本机 Coflux.app 没在跑」而 app 其实在跑。修复后通道重连必须重新 register（epoch 递增）。Based on: `apps/desktop/src/main/executor-host.ts:152-157` 与 `crates/worker/src/agent_ctl/executor.rs:316`；本机日志 `~/Library/Logs/Coflux/main.log` 可见最后一次报到停在 09-18 00:04 之后再无补报。

## Direction

数据从中心流向设备（中心 → 下发 → daemon 缓存文件 → 主进程读），控制从设置页流回中心（主进程 → HTTPS → 中心）。M1→M5 基本串行，后一个需要前一个定下的形状；**M6 与其余五个完全无关，可以并发做**。

### Milestone 1: 中心能存取 executor 配置，凭据以密文落库

新增 `executor_settings` 表（主键 `(account_id, device_id)`，`device_id` 可空）与读写入口。凭据字段是 AES-256-GCM 密文，密钥来自 `server.env`；密钥缺失时写入凭据的请求以可读错误拒绝，且既有明文路径一条都不许留。迁移追加在 `apps/server/src/infra/database/schema-migrations.ts` 的既有 version 序列之后。

Validation: `pnpm -C apps/server build` -> exit 0。

### Milestone 2: 协议能承载配置的下发与读写

只需要 `daemon.proto` 增加中心 → daemon 的配置下发。**`device.proto` 不动**（revised on advisor review）：读路径是主进程直接读 daemon 的缓存文件、写路径是主进程 HTTPS 请求中心，client ⟷ daemon 之间没有新增的配置消息，因此也不涉及 device 侧的能力协商。

新增的 ServerToDaemon 控制消息必须同步在 `apps/server/src/daemon-capabilities.ts` 加能力名常量，并与 `crates/worker/src/main.rs` 的常量保持一致。**中心必须在下发前检查该能力名，不具备就不发**（revised on advisor review）：下发是 push 而不是 request，没有回执路径，`requireOnlineDaemon` 那类错误无人接收；旧 worker 对未知 oneof 解出 `payload: None` 后直接打日志丢弃，症状是缓存文件永远不出现、桌面侧无限等待且没有任何可读原因。配套地，主进程在写完中心后若在合理时限内没等到缓存文件更新，要给出「本机 daemon 版本过旧，请升级后重试」这类明确提示，而不是转圈。

依赖 M1（字段形状）。Validation（revised on advisor review，原先那条是空转——`packages/protocol` 根本没有 `build` 脚本，`pnpm -r build --filter` 对没有该脚本的包会直接跳过并 exit 0，什么都没验）：在 `proto/` 下 `buf lint` 与 `buf generate`，然后确认 `packages/protocol/src/gen`、`crates/protocol/src/gen`、`packages/swift-client/Sources/CofluxProtocol/Generated` **三处**生成产物都已提交且工作区对这三个路径为空（`buf.gen.yaml` 是 `clean: true`，漏提一处 CI 就红），再跑 `node scripts/check-protocol-breaking.mjs`。这组就是 CI 的协议门（`.github/workflows/ci.yml:115-124`）。另外 `cargo build -p coflux-worker` -> exit 0。

### Milestone 3: daemon 接收下发并落成本机缓存文件

daemon 收到中心下发后，把配置落成 `$COFLUX_HOME` 下权限 `0600` 的明文 JSON，写入走「临时文件 + rename」保证读方不会看到半截内容。**落盘范式对齐 `crates/worker/src/creds.rs:1`（存 device_token 的 `credentials.json`），不是 `conn_state.rs`**（revised on advisor review）——后者顶部原文写明「不含密钥、无需 0600」，照抄会让凭据落成宽权限文件。daemon 侧不提供任何配置读写接口：读方是同机的桌面主进程，直接读这个文件。

依赖 M2。Validation: `COFLUX_HOME= cargo test -p coflux-worker` -> exit 0；`cargo clippy -p coflux-worker --all-targets -- -D warnings` -> exit 0。

### Milestone 4: 桌面主进程持有长期 ModelRuntime，配置来自 daemon

主进程启动一个长期 `ModelRuntime`（`allowModelNetwork: false`），pi 的工作目录持久化在 userData 下，与用户 `~/.pi` 的隔离手段一条不少。配置**读**自 daemon 的缓存文件、**写**经 HTTPS 发中心，两条路都不经渲染层。自定义端点经 `registerProvider()` 注入（凭据不走它，见 Decisions）。runner 的启动协议保持「主进程把 provider/模型/凭据放进 start 消息」的形状，只是这些值的来源从本地 JSON 换成了 daemon 缓存；同时 start 消息要带上自定义端点定义，让 runner 那个 runtime 也 `registerProvider()` 一次。两个 runtime 的凭据都只走内存注入。

依赖 M3。Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0。

### Milestone 5: 设置页按产品结论重做

Provider 下拉（内置 + 自定义端点同一列表）、可搜索的模型选择（跨 provider 搜，显示上下文窗口与价格）、只写凭据、保存时校验并分清失败原因（provider 不存在 / 模型不存在 / 凭据没过）、「测试连接」真发一次最小请求回报 token 数与延迟、自定义端点的增删改（名称、baseUrl、api 类型四选一、凭据、模型 id 手填、高级折叠里的兼容开关）、离线时修改控件置灰并说明。自定义模型按 Decisions 里定的占位值补齐 pi 必填的元数据，**且规格位显示「未知」而不是把占位数当真**。keyless 的本地服务（Ollama 这类）要自动填占位 key——pi 要求有凭据才认为模型可用（`dist/core/provider-composer.js:388-400`）——但占位 key 同样经 `CredentialStore` 填，不走 `registerProvider({apiKey})`。

依赖 M4。Validation: `pnpm -C apps/desktop typecheck` -> exit 0；`pnpm -C apps/desktop test` -> exit 0。UI 由用户人工走查，不要写 Playwright/UI 走查脚本。

### Milestone 6: 通道重连后 host 重新登记

device 通道断开重连后桌面重新向 daemon register（epoch 递增），不再因 `daemonId` 未变而静默跳过。与其余 milestone 无依赖关系。

**触发源在渲染层，不只在主进程**（revised on advisor review）：`apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:81-87` 只在 `localDaemonId` 变化或 effect 卸载时调 `setExecutorChannel`，device 通道断开重连**根本不会再发**。所以只改主进程 `executor-host.ts:151` 那个 early return 是修不好的——它压根收不到第二次通知。渲染层的 bridge 要观察 device 通道状态，在重连时重新宣告（重发 `setExecutorChannel`，或带一个 generation 号让主进程能区分「同一个 daemon 的新一次连接」），主进程据此 epoch+1 重新 register。两处都要改，缺一不可。

Validation: `pnpm -C apps/desktop test` -> exit 0（补一条覆盖「同一 daemonId 断开后重连仍会 register」的用例；`test` 的 glob 覆盖 `src/main/*.test.ts`，主进程侧的用例落那里）。

## Landmines

- **能力名门禁**：新增 ServerToDaemon 控制消息而不加能力名，旧 worker 会静默丢弃，症状是 agent 白等到超时且没有可读原因。门禁按名字、绝不比较版本号（dev/测试 worker 报 `builtin`）。见 `apps/server/src/daemon-capabilities.ts:1-14` 与 `proto/coflux/v1/daemon.proto:19-23`。
- **pi 会把 API key 当「config value」解析：`!` 开头执行 shell、`$` 开头读环境变量**。`dist/core/resolve-config-value.js:66,134,161` 里是 `spawnSync/execSync`。凡是经 `registerProvider({apiKey})` 或 `headers` 传进去的值都会过这个 resolve（`dist/core/provider-composer.js:216-241`），经 `setRuntimeApiKey` / 自实现 `CredentialStore` 的则原样返回（`dist/core/runtime-credentials.js:20`）。配置改成账号级共享之后，走错路径 = 给任何能改账号配置的人一条在每台桌面主进程里执行任意命令的通道。详见 Decisions 里对应那条。

- **凭据绝不进渲染层**：现有契约是渲染层只知道「配没配」，永远拿不到 key 本身（`apps/desktop/src/main/executor-config.ts:14-16`）。注意 executor 现有的 register/report 帧确实是经渲染层转发的（`executor-host.ts:63` → `use-executor-bridge.ts`），所以「顺手复用那条路来搬配置」是个很自然的动作——本 plan 明确不走它，凭据的读路径是主进程直接读文件。不要因为数据换了来源就把密文或明文传给 renderer。

- **`utilityProcess` 里没有 `safeStorage`**：Electron 的 `Utility` 命名空间只有 `net / parentPort / systemPreferences`。runner 是 `utilityProcess.fork` 出来的（`executor-host.ts:170`），任何「让 runner 自己解密凭据」的设计都做不到，凭据只能由主进程经 start 消息递进去。
- **pi 的路径回退**：`getAgentDir()` 会回退到用户真实的 `~/.pi/agent`，且 `ModelRuntime` 独立解析自己的路径——给 ResourceLoader 和 session 传了目录**不等于**运行时也隔离了。环境变量必须在 `import` pi 之前设好。见 `apps/desktop/src/main/executor-runner.ts:160-200`。
- **`setRuntimeApiKey` 必须 await**：它异步且走内部凭据操作队列，不 await 会让第一个请求在 key 就位前发出。见 `apps/desktop/src/main/executor-runner.ts` 该调用处的注释。
- **本机 Rust 测试会被 coflux 自身污染**：`cargo test` 跑 agent-activity/presence 相关用例时本机必假红并拖住整套，解法是 `COFLUX_HOME= cargo test -p <crate>`。不要把这类红当成回归。
- **新增黑盒用例的端口**：派生新端口前先 grep 仓库里所有 `const PORT`，端口写死撞车会让整个测试文件崩掉，表现不像端口问题。
- **`.pi/` 目录的攻击面**：workspace 里的 `.pi/settings.json` 能改 executor 的 thinking level、transport、retry、provider headers，所以 settings 是 `SettingsManager.inMemory()` 而非从磁盘读。配置持久化后仍然只读 coflux 自己的目录，不要为了「让用户能调」去读工作区的 pi 设置。

## Scope

In scope:
- `apps/server/src/infra/database/schema-migrations.ts`（追加迁移）
- `apps/server/src/`（配置读写入口、加密、能力名常量、下发前的能力检查）
- `proto/coflux/v1/daemon.proto`（`device.proto` 不动）
- 协议生成产物三处：`packages/protocol/src/gen`、`crates/protocol/src/gen`、`packages/swift-client/Sources/CofluxProtocol/Generated`（`buf generate` 产出，必须一起提交）
- `crates/worker/src/`（下发接收、缓存文件落盘）
- `apps/desktop/src/main/executor-*.ts`（长期 ModelRuntime、配置来源、start 消息形状、host 重新 register）
- `apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts`（通道重连时重新宣告，M6 的触发源）
- `apps/desktop/src/renderer/components/settings/executor-section.tsx` 及其配套
- `apps/desktop/src/shared/ipc.ts` 与 `apps/desktop/src/main/ipc.ts`（**两份都要动**）、`apps/desktop/src/shared/desktop-bridge.ts`（类型；注意渲染层的 `@/desktop-bridge` 指向的是另一个文件 `src/renderer/desktop-bridge.ts`）、preload
- `wiki/plans/README.md`（状态）

Out of scope:
- **OAuth 订阅登录** —— 下一版，本版不得出现入口或半成品 UI。
- **设备级覆盖的 UI** —— 表里留位，UI 不做。
- **executor 在非桌面设备上运行** —— 本版只是把读路径铺到 daemon，不实现 cofluxd 侧的 executor 宿主。
- **沙箱与 runner 的执行边界** —— `(deny network*)` 实测同时封 UDS，本需求不碰。
- **`~/.pi` 的导入/复用** —— 隔离边界不变。
- 发版、部署生产、打 tag —— 用户的事。

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| 装依赖（**先做**） | `pnpm install` | exit 0；本 worktree 是新切出来的，没有 `node_modules`，所有 pnpm 命令在此之前都会失败 |
| 协议 lint | `buf lint`（在 `proto/` 下） | exit 0 |
| 协议生成 | `buf generate`（在 `proto/` 下） | exit 0，且生成产物三处均已提交、工作区对这三个路径为空 |
| 协议兼容 | 在 `proto/` 下 `node ../scripts/check-protocol-breaking.mjs "../.git#ref=<base_sha>,subdir=proto"` | exit 0（**必须带 baseline 参数**，不带只会打印用法并 exit 1；CI 传的是 PR base，本地用 main 的 SHA） |
| 桌面类型检查 | `pnpm -C apps/desktop typecheck` | exit 0 |
| 桌面单测 | `pnpm -C apps/desktop test` | exit 0 |
| server 构建 | `pnpm -C apps/server build` | exit 0（`tsc -p tsconfig.json`，会写 gitignored 的 `dist/`） |
| Rust 单测 | `COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Rust 零警告构建 | `cargo build -p coflux-worker` | exit 0 且零 warning（这才是 `AGENTS.md` 要求的那道门） |
| ~~Rust lint~~ | ~~`cargo clippy -p coflux-worker --all-targets -- -D warnings`~~ | **不要用这条判定本改动**：本仓库 CI 完全不跑 clippy，baseline 上它就报 23 个 error（集中在 `observed.rs` 8、`device.rs` 7、`main.rs` 4 等既有代码）。2026-09-19 验证时确认这 23 条全部落在本次 diff 的 hunk 之外 |
| 黑盒 (acceptance) | `pnpm -C tests test` | exit 0（需要本机 PG:5432，Docker 是 OrbStack，先 `orb start`） |

## Done criteria

- [ ] All listed commands pass.
- [ ] 配置在中心落库，凭据是密文；密钥未配置时写凭据被可读地拒绝而非降级成明文。
- [ ] 断网时 `coflux executor run` 仍能提交（读走 daemon 缓存）；此时设置页的修改控件置灰并说明原因。
- [ ] 设置页能选出 provider 与模型（模型可搜索、跨 provider）、保存时当场校验并分清失败原因、「测试连接」回报 token 数与延迟。
- [ ] 能添加一个自定义端点、在 provider 列表里选到它，**并且用它真的跑通一次 `coflux executor run`**（只在设置页选得到不算完成——runner 是另一个进程里的另一个 ModelRuntime）。
- [ ] device 通道断开重连后 host 会重新 register。
- [ ] 与用户 `~/.pi` 的隔离未被削弱：环境变量在 import pi 之前设置，`authPath`/`modelsPath`/`modelsStorePath` 仍显式指向 coflux 自己的目录。
- [ ] 凭据未以任何形式（明文或密文）到达渲染层：读路径是主进程直接读 daemon 缓存文件，不经 IPC 转发。
- [ ] 凭据未经 `registerProvider()` 的 `apiKey` / `headers` 传给 pi——只经 `setRuntimeApiKey` 或内存 `CredentialStore`。
- [ ] 密钥轮换后旧密文仍可解（key-id 方案），解不开时给出可读错误而非静默变成未配置。
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- 为了让配置跑通，需要削弱 runner 的五条 pi 集成决策或与 `~/.pi` 的隔离中的任何一条。
- 为了让凭据跑通，需要在中心以明文或可逆性弱于既定方案的形式存储。

## Maintenance notes

- 中心从此持有可还原的秘密，这是安全模型的分水岭。任何新增的「中心存 X」都要先问 X 能不能只存 hash。密钥在 `server.env`，跟着备份与轮换流程走。
- **这次迁移是一道单向门**：`schema-migrations.ts:1558-1561` 规定 DB 版本高于代码可识别范围时旧 server **拒绝启动**，所以部署带本迁移的版本之后，无法把 server 回滚到上一版。发布前确认这是可接受的，或先准备好降级迁移。
- **两处 not-ready 文案已经陈旧**：`apps/desktop/src/main/executor-config.ts:94-97` 与 `crates/worker/src/agent_ctl/executor.rs:322` 都还在说「打开账号菜单的「Executor 设置…」」，而那个入口早已并入设置页（见 `executor-section.tsx:13` 的注释）。桌面侧这次顺手改掉；daemon 侧那句改了要等 worker 发版才生效。
- `device_id` 那一列现在全是 NULL。下一版做设备覆盖时只加 UI 与读取回退，不要改主键。
- OAuth 是下一版：pi 有 7 家支持订阅登录（anthropic / openai-codex / github-copilot / xai / openrouter / kimi-coding / radius），`ModelRuntime.login(providerId, "oauth", interaction)` 的交互契约只有 `prompt()` 与 `notify()`，Electron 里实现没有障碍。本版的凭据数据形态已经为它留好了位置。
- executor 目前仍只能在装了 Coflux.app 的机器上运行（pi 是 Node 包、沙箱是 macOS 的 `sandbox-exec`）。本版铺好了配置的读路径，真要让 cofluxd 自己跑 executor，缺的是 Node 运行时与非 macOS 的沙箱方案。
