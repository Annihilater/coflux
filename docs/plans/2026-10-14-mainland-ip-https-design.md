# 大陆 IP 上的私有中心

状态：方案，2026-10-14。这是一台新机器的布署方式，不改 [deployment.md](../deployment.md) 里记录的现有生产主机。

这台机器跑中心、数据库，以及一个 DERP/STUN 节点。桌面应用和每台设备上的 daemon 留在你实际使用的电脑上，由它们向外连接。这台主机不需要域名，也不监听 80 和 443。

## 为什么是这个形状

大陆云在 80 和 443 上过滤未备案的**名字**。它看的是 TLS 的 SNI 和 HTTP 的 Host。[deployment.md](../deployment.md) 记下了腾讯云的行为：一旦发现这个名字，HTTP 会被转到拦截页，HTTPS 在 ClientHello 之后被重置。裸 IP 走另一个端口时，握手里没有这个名字，过滤器对不上。端口要故意选高的。不要再额外开放 443。

`COFLUX_PUBLIC_URL` 已经接受带 IP 和端口的 `https` 地址。桌面接受 `wss://<ip>:<port>/client`。`cofluxd` 接受 `wss://<ip>:<port>/daemon`。CLI 接受 `https://<ip>:<port>`，并且除了 localhost 以外拒绝明文 `http`。当前程序不接受的是这张证书。

## 动手之前先看信任

私有 CA 是对的证书。四套 TLS 栈会看到它，其中只有两套能从程序外面配成信任。

| 谁在连 | TLS 栈 | 装进操作系统的 CA 它认吗 |
| --- | --- | --- |
| 系统浏览器里的设备授权页和登录页 | 操作系统信任库 | 认，装上 CA 之后 |
| 桌面窗口里的 `/client` WebSocket | Chromium，也就是操作系统信任库 | 认，装上 CA 之后 |
| `coflux` 账号命令 | `ureq` 默认的系统 TLS | 认，装上 CA 之后 |
| 桌面主进程里的 Tailcat 控制 WebSocket | Node 的 `ws`，根证书烤在 Node 里 | 不认。`NODE_EXTRA_CA_CERTS` 可以，但从访达打开的打包应用拿不到 shell 里的变量 |
| 设备 runtime 的 `/daemon` WebSocket | `tokio-tungstenite`，编译时用的是 `rustls-tls-webpki-roots`（`crates/runtime/Cargo.toml`） | 不认。没有开关，也不读操作系统信任库 |
| DERP | Tailscale 的 `CertName: sha256-raw:…` 指纹，`transport/tailcat` 里已经实现 | 指纹代替公共 CA 校验。私有叶子证书可以用 |

runtime 这一条才是关键。设备 daemon 完不成 `wss://`，账号里就不会出现这台设备。桌面可以对着已信任的 CA 打开登录页，后面仍然没有设备。把 CA 装进 macOS 钥匙串，浏览器和 CLI 需要这一步，daemon 不会因此连上。

没有「跳过证书校验」的开关，也不该加一个。DERP 节点上的 `InsecureForTests` 只有主机名是环回地址时才会被接受。

runtime 和桌面主进程的 WebSocket 能加载这份 CA 之前，不要拿这台中心做设备注册。这个改动现在不在代码里。下面的服务器布局是为它准备的：CA 文件是输入，Caddy 和 `derper` 对外提供的是叶子证书。信任这份 CA 的客户端，轮换叶子时不用再改。DERP 的指纹是叶子的哈希，所以换叶子时要在 `COFLUX_DERP_REGIONS` 里换新指纹。

在客户端改动落地之前，今天的 daemon 唯一能连完的控制地址是 `ws://`。CLI 不会对公网 IP 使用明文 HTTP。明文补不上这个缺口。

## 布局

```text
  桌面 / coflux / cofluxd
        |  wss://<公网 IP>:8443/client
        |  wss://<公网 IP>:8443/daemon
        |  DERP tcp/<公网 IP>:8444   STUN udp/3478
        v
  Caddy :8443  ----->  coflux-server 127.0.0.1:8787
                       Postgres       127.0.0.1:5432
                       准入           127.0.0.1:8793
  derper :<公网 IP>:8444  （自己做 TLS，同一张叶子）
  derper STUN  udp/<公网 IP>:3478
```

安全组和主机防火墙开同一份清单：

| 放开 | 用途 |
| --- | --- |
| tcp/22 | SSH。能限制来源就限制 |
| tcp/8443 | 中心，由 Caddy 终结 TLS |
| tcp/8444 | DERP |
| udp/3478 | STUN。没有应答时，不在同一局域网的两端会一直走中继，产品不会报错 |

这些保持关闭：tcp/80、tcp/443、tcp/5432、tcp/8787、tcp/8793。Node 进程只绑环回。对外的 HTTP 只有 Caddy。准入留在环回上，因为 `derper` 就在同一台机器；把它公布出去，校验地址就会变成一条远程依赖。

端口预览需要 `<shortId>-<proxyHost>` 这种主机名。只有 IP 的中心没有这个名字，预览链接打不开。设备授权页挂在 `COFLUX_PUBLIC_URL` 自己上面（`/authorize/<token>`），不需要第二个名字。

GitHub 和 Google 登录的回调地址要落在 `COFLUX_PUBLIC_URL` 下面。这两家拒绝裸 IP。提供商相关的变量留空，用 `COFLUX_AUTH=password`。

## 证书

在你自己控制的机器上生成 CA。只把 `ca.crt`、`server.crt`、`server.key` 拷到服务器。`ca.key` 留在服务器外面，它只用来续签叶子。

下面所有出现 `203.0.113.10` 的地方，包括 SAN，都换成这台机器的公网地址。SAN 如果写成 DNS 名字，云过滤的那个名字就回来了，而且和客户端拨的 IP 对不上。

```sh
mkdir -p /etc/coflux/tls && chmod 700 /etc/coflux/tls
cd /etc/coflux/tls

openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/CN=Coflux Private CA" \
  -addext "basicConstraints=critical,CA:true" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr \
  -subj "/CN=203.0.113.10"

cat > server.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:203.0.113.10
EOF

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile server.ext

chmod 600 ca.key server.key
rm -f server.csr server.ext ca.srl
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name'
```

最后一条命令必须看到 `IP Address:203.0.113.10`。SAN 缺失的话，Caddy 发出去的证书和客户端拨的地址对不上。

DERP 的指纹是叶子证书 DER 字节的 SHA-256，`sha256-raw:` 比的就是这个：

```sh
openssl x509 -in /etc/coflux/tls/server.crt -outform DER | openssl dgst -sha256 -hex
```

`derper` 的手动模式从证书目录读取 `<主机名>.crt` 和 `<主机名>.key`。这里的主机名就是 IP：

```sh
ln -sf /etc/coflux/tls/server.crt /etc/coflux/tls/203.0.113.10.crt
ln -sf /etc/coflux/tls/server.key /etc/coflux/tls/203.0.113.10.key
```

每台要开应用或 CLI 的 Mac 上，把 CA 装一次。这只覆盖操作系统那一半信任，覆盖不了 runtime：

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ca.crt
```

## Caddy

用官方包装 Caddy。这台主机没有别的站点，这份文件就是全部配置。`auto_https off` 让 Caddy 离开 80 和 443。

`/etc/caddy/Caddyfile`：

```caddyfile
{
	auto_https off
}

https://:8443 {
	tls /etc/coflux/tls/server.crt /etc/coflux/tls/server.key
	reverse_proxy 127.0.0.1:8787
}
```

`reverse_proxy` 会转发 WebSocket 升级，并带上 `X-Forwarded-For`。中心只在 TCP 对端是环回时信任这个头（`apps/server/src/transport.ts` 里的 `requestAddress`），所以 Node 进程不能从别的地方连进来。改完以后执行 `caddy validate`，再 `systemctl reload caddy`。

从外面用刚生成的 CA 检查：

```sh
curl --cacert /etc/coflux/tls/ca.crt -sS -o /dev/null -w "%{http_code}\n" \
  https://203.0.113.10:8443/health
```

返回 `200` 表示 Caddy、TLS 和中心是对齐的。还没装 CA 的浏览器报警是预期行为。

## 中心

进程和生产上跑的是同一个：检出某个发布标签的分离头、Node 22、`node --import tsx apps/server/src/index.ts`，Postgres 只听 `127.0.0.1`。不要设 `COFLUX_DEV=1`。没有这个标志时，缺了 `DATABASE_URL` 进程会拒绝启动，这正是要的行为。

```sh
# 用发行版的 Postgres，只听 127.0.0.1。
sudo -u postgres createuser coflux
sudo -u postgres createdb -O coflux coflux
# 给这个角色设密码，写进 DATABASE_URL。不要用 trust 认证。

install -d -m 0755 /opt/coflux /var/backups/coflux
# 把一个发布标签放进 /opt/coflux。对分支做 git pull 是错的操作；
# 检出你打算跑的那个标签。
cd /opt/coflux && pnpm install --frozen-lockfile
```

从大陆主机拉 git 和 npm 仓库经常很慢。这是一次性的安装成本，不是把进程绑到公网地址上的理由。

`/etc/coflux/server.env`，权限 `0600`：

```sh
DATABASE_URL=postgres://coflux:<密码>@127.0.0.1:5432/coflux
COFLUX_HOST=127.0.0.1
COFLUX_PORT=8787
COFLUX_AUTH=password
COFLUX_PUBLIC_URL=https://203.0.113.10:8443
COFLUX_DAEMON_URL=wss://203.0.113.10:8443/daemon
COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024

COFLUX_DERP_ADMISSION_PORT=8793
COFLUX_DERP_ADMISSION_TOKEN=<至少 32 个随机字符>
COFLUX_DERP_REGIONS=[{"RegionID":901,"RegionCode":"private","Nodes":[{"Name":"private-1","RegionID":901,"HostName":"203.0.113.10","IPv4":"203.0.113.10","DERPPort":8444,"STUNPort":3478,"CertName":"sha256-raw:<叶子证书 sha256 十六进制>"}]}]

# 可选。不设的话中心照样启动，保存 executor 的 API key 会被拒绝。
# COFLUX_EXECUTOR_KEYS=k1:<32 字节随机数的 base64>
```

`COFLUX_PUBLIC_URL` 必须带端口。中心用请求的 Host 和这个 URL 的 host 比较来选链接，host 里包含 `:8443`。不带端口的 URL 会生成浏览器打不开的授权链接。

`COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024` 是生产上的值。默认 64 会在认证刚结束、daemon 一下子报上一大批工作区时把连接断开，然后 daemon 会循环重连。

`COFLUX_AUTOUPDATE_REPO` 留空。中心否则会去轮询 `api.github.com`，从大陆经常失败；在你决定之前，私有中心也不该把上游 runtime 推下去。以后要开的话，同时设 `COFLUX_AUTOUPDATE_MIRROR_BASE=https://dl.coflux.dev`；大陆那台生产中心读的就是这个镜像。

只有在你要把提供商密钥存进中心时才生成 executor 密钥：

```sh
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
```

以后改这个值，已经存下的密钥就读不出来。轮换时把旧的 id 留在列表里。

systemd 单元 `/etc/systemd/system/coflux-server.service`：

```ini
[Unit]
Description=Coflux centre
After=network.target postgresql.service
Wants=postgresql.service

[Service]
WorkingDirectory=/opt/coflux
EnvironmentFile=/etc/coflux/server.env
ExecStart=/usr/bin/node --import tsx apps/server/src/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

实际安装的 node 如果不在 `/usr/bin/node`，改成那个路径。然后：

```sh
systemctl enable --now coflux-server
curl -fsS http://127.0.0.1:8787/health
journalctl -u coflux-server -n 50 --no-pager
```

创建桌面要登录的账号：

```sh
set -a && . /etc/coflux/server.env && set +a
node --import tsx scripts/create-user.mjs --email you@example.com --password '<密码>'
```

迁移在启动时放在一个事务里跑。以后检出带表结构迁移的标签之前，先做一次 `pg_dump -Fc`。每天往 `/var/backups/coflux` 倒一份、留两周，和生产上的习惯一致，一台机器够用。

## DERP 和 STUN

用 `transport/tailcat/go.mod` 钉住的 Tailscale 修订构建官方 `derper`（`tailscale.com v1.103.0-pre.0.20260904030409-31d8badb3bfb`）。不要构建已经退役的 `coflux-relay`。服务器只需要 `derper` 这个二进制；客户端自己带 `coflux-transport`。

`derper` 绑公网地址，不绑环回，这样它自带的 STUN 才能在同一地址上应答。放在 Caddy 后面、听 `127.0.0.1` 的 `derper` 做不了 STUN。`-hostname` 用 IP，和证书 SAN 一致。`-certmode manual` 跳过 Let's Encrypt。必须加 `-verify-client-url-fail-open=false`；上游的默认是问不到中心时照样给所有人中继。

证书文件名用你构建出来的二进制跑一次 `derper -help` 确认。下面这些参数是生产已经在用的：

```sh
/opt/coflux-derp/derper \
  -a 203.0.113.10:8444 \
  -hostname 203.0.113.10 \
  -certmode manual \
  -certdir /etc/coflux/tls \
  -verify-client-url 'http://derp:<token>@127.0.0.1:8793/derp-verify' \
  -verify-client-url-fail-open=false
```

token 和 `COFLUX_DERP_ADMISSION_TOKEN` 是同一个值。把命令放进 systemd 单元，环境文件权限 `0600`，这样 token 不会出现在谁都能读的单元文件里。用户名 `derp` 被忽略，密码才是 token。Go 会把这个 URL 转成 Basic 头，普通访问日志里看不到它。

`derper` 启动时会检查证书和 `-hostname` 是否匹配。IP 形式的 SAN 才能让 IP 主机名通过。它拒绝证书就停在这里改 SAN。不要为了过检查把主机名改成 DNS 名字。

`COFLUX_DERP_REGIONS` 就是 `server.env` 里的那段 JSON。中心检查区域 id、节点名和主机名，然后把对象原样转发，所以 `IPv4`、`DERPPort`、`STUNPort` 和 `CertName` 都会到客户端。客户端拨的是 `IPv4`，这个节点不需要 DNS。`CertName` 就是叶子的 `sha256-raw:` 指纹。不要写 `InsecureForTests`。

STUN 没有应答时是静默的：侧栏会一直显示中继。设备连上之后，看 STUN 成功计数有没有增加。如果打开 `derper` 自己的调试端口，它留在环回上。

## 客户端：等 CA 能被加载之后

桌面打包版，`~/Library/Application Support/Coflux/settings.json`：

```json
{
  "serverUrl": "wss://203.0.113.10:8443/client"
}
```

重启应用。同一次启动也可以用 `--server=` 或 `COFLUX_SERVER_URL`。显示服务器地址的菜单项会打出它读的那个文件。

要托管设备的机器上：

```sh
cofluxd up --server wss://203.0.113.10:8443/daemon
```

`coflux login` 和其他账号命令用 `https://203.0.113.10:8443`。它们会用上装进操作系统的 CA。daemon 不会。

## 地址变了的时候

叶子的 SAN、`COFLUX_PUBLIC_URL`、`COFLUX_DAEMON_URL`、DERP 的 `HostName` 和 `IPv4`、`derper` 的 `-a` 和 `-hostname`，以及每台客户端的地址，一起改。已经信任这份 CA 的客户端，新叶子仍用同一把 CA 签发时不用换 CA。它们需要新的 `sha256-raw` 指纹；控制连接起来之后，中心会把区域配置一起发下去。指望 DERP 成功之前，先在 `server.env` 里更新指纹。

## 怎么检查

1. 在服务器上执行 `curl -fsS http://127.0.0.1:8787/health`。
2. 从另一张网络执行 `curl --cacert ca.crt https://203.0.113.10:8443/health`，返回 `200`。
3. 同一地址不带 `--cacert` 时校验失败，送出的证书 SAN 是这个 IP。
4. 这个地址上的 80 和 443 保持关闭（`nc -z` 超时或被拒绝）。
5. 装了 CA 的浏览器打开 `https://203.0.113.10:8443/health` 不再报警。
6. runtime 信任这份 CA 之后：桌面能登录，`cofluxd status` 显示设备已连接，第二台设备能打开终端。只有 DERP 通了、daemon 还在反复重连，那是信任缺口，不是防火墙漏了。
7. `journalctl -u coflux-derp` 里没有 `verify-client-url` 失败。这种失败是关闭转发的：控制面看起来正常，每个远程会话都停在「正在探测」。

## 这份方案里故意没有的

[deployment.md](../deployment.md) 里的生产路径——Cloudflare、`coflux.dev`、已备案的 `yourantiandi.com`、单独的中继机——是公共服务躲开名字过滤的办法。一台只允许用 IP 和端口的中心，不该照那个形状做。

这里不含代码改动。缺的是 runtime 的 WebSocket 客户端和桌面主进程的 WebSocket 去加载 `ca.crt`。DERP 已经有指纹，不需要这个改动。
