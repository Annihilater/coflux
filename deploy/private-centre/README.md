# Debian 私有中心：物料和安装流程

这是 `private-centre` 分支上的部署说明。`main` 保持和上游一致，私有化编译的改动只在这个分支。不带下面两个编译变量时，编出来的程序仍然默认连接作者的服务器。

可以拿到服务器上直接安装的包是 `deploy/private-centre/out/coflux-private-centre-2.19.1-private.1.tar.gz`。它对应本地标签 `v2.19.1-private.1`，没有推到 GitHub：上游的 `v*` 发布只会接受打在 `origin/main` 尖上的标签。包里没有证书私钥。在 Debian 上解压后执行 `PUBLIC_IP=你的公网IP bash server/install.sh`，证书按这个地址现签。短说明在包内的 `INSTALL.txt`。

一台新的 Debian 机器跑中心、Postgres、Caddy 和一只 stock `derper`。桌面和设备 daemon 留在你自己的电脑上。没有域名，不听 80 和 443。证书是私有 CA 签的，叶子证书的 SAN 是这台机器的公网 IPv4。

建议用 Debian 13。Debian 12 也能装空库。只有将来要恢复现有生产库的备份时才必须用 13：那边是 PostgreSQL 17，12 自带的是 15，17 的 dump 恢复不进 15。

## 现在能用到哪

服务器按下面的步骤装完之后，`/health` 能通，邮箱密码账号能建。

作者发布的桌面、npm 上的 `cofluxd` 和 GitHub Releases 里的 runtime 仍然默认连接 `api.coflux.yourantiandi.com`，也不信任你的私有 CA。节点要默认接到你的服务器，必须用本分支、带上你的地址和 `ca.crt` 重新编译桌面、`cofluxd`、Rust `coflux` 和 runtime。编进去之后，不带 `--server` 的对接命令指向你的 `wss://公网IP:8443`，这些程序也信任这把 CA。这种私有编译不会去 `dl.coflux.dev` 下载作者的发布包；`cofluxd up` 要带上你自己编译的 `--bin-dir`。

## 两台机器各干什么

准备在你自己的 Mac 上做。CA 私钥只留在 Mac。服务器只收到叶子证书、叶子私钥、CA 公钥、`derper` 二进制、Node 安装包和源码包。

服务器是 Debian。它不需要 Go，也不要从 GitHub 拉仓库。它要能访问 `registry.npmmirror.com`，用来装 pnpm 和 npm 依赖。

云上先绑一个固定公网 IPv4，再签发证书。地址写进了证书 SAN、Caddy、环境变量和 DERP 区域里。

## 物料里有什么

仓库目录是 `deploy/private-centre/`。

| 路径 | 作用 |
| --- | --- |
| `site.conf.example` | 复制成 `site.conf` 后填写。`site.conf` 不入库 |
| `mac/prepare.sh` | 在 Mac 上按顺序做完准备 |
| `mac/10-make-ca.sh` | 只跑一次，生成 CA。已有 `ca.key` 就拒绝覆盖 |
| `mac/20-issue-leaf.sh` | 按 `PUBLIC_IP` 签发叶子，写出指纹 |
| `mac/30-build-derper.sh` | 用仓库钉住的 Tailscale 模块编译 Linux `derper` 和本机 `stunc` |
| `mac/40-fetch-node.sh` | 从 npmmirror 下载 Node 22 的 Linux 包并核对 SHA256 |
| `mac/50-make-bundle.sh` | 打物料包。包里出现 `ca.key` 会直接失败 |
| `server/install.sh` | 在 Debian 上安装或重放。数据库密码和 DERP 准入 token 已存在就沿用 |
| `server/healthcheck.sh` | 装完在服务器上自检。安装结束时会自动跑 |
| `client/mac-trust-ca.sh` | 把 CA 装进 macOS 系统钥匙串 |
| `client/mac-verify.sh` | 从 Mac 上检查 TLS、关闭的端口和 STUN |

准备完成后，包在 `~/.coflux-private-ca/out/coflux-private-centre.tar.gz`，权限 `0600`。里面没有 `ca.key`。

## 准备机

Mac 上要有 git、python3、curl、openssl。编译 `derper` 还要 Go 1.21 或更新；脚本用 `GOTOOLCHAIN` 拉 1.27.1。工具链下载失败时，自己装好 Go 1.27.1，再执行：

```sh
cd deploy/private-centre
GOTOOLCHAIN=local mac/30-build-derper.sh
```

Go 模块走 `site.conf` 里的 `GOPROXY`，默认 `https://goproxy.cn,direct`。

## 1. 填写 site.conf

在仓库根目录：

```sh
cd deploy/private-centre
cp site.conf.example site.conf
```

打开 `site.conf`，至少改这两项：

- `PUBLIC_IP`：云主机的公网 IPv4。不要填 `203.0.113.10`，脚本会拒绝这个示例地址。
- `SRC_REV`：要装到服务器上的 git 修订，默认 `HEAD`。必须是已经提交的修订。工作区里还没提交的代码不会打进包。

其余可以保持默认：

- 中心 TCP `8443`，DERP TCP `8444`，STUN UDP `3478`，SSH `22`
- `ARCH=amd64`。ARM 云主机改成 `arm64`
- `NODE_MODE=tarball`，`NODE_VERSION=22.23.3`。pnpm 11.6.0 要求 Node 至少 22.13。Debian 12 自带 Node 18，Debian 13 自带 Node 20，都不能用
- `NODE_MIRROR` 和 `NPM_REGISTRY` 指向 npmmirror

`PKI_DIR` 留空时，证书放在 `~/.coflux-private-ca`，不放进仓库。

## 2. 在 Mac 上做出物料包

```sh
cd deploy/private-centre
mac/prepare.sh
```

它依次做这些事：

1. 没有 CA 就运行 `10-make-ca.sh`。CA 私钥是 `~/.coflux-private-ca/ca.key`，权限 `0600`。这一步以后不要再跑，除非你确定要换一把根。
2. `20-issue-leaf.sh` 签发叶子。SAN 必须是 `IP Address:` 加上 `PUBLIC_IP`。脚本会自己校验，并把叶子 DER 的 SHA-256 写到 `pin.txt`。叶子有效期 825 天，这是 macOS 对本地信任根下 TLS 证书的上限。再跑一次会换一张新叶子，指纹跟着变。
3. `30-build-derper.sh` 在 `transport/tailcat` 里编译。`derper` 是给服务器的 Linux 静态二进制，`stunc` 是给这台 Mac 做 STUN 检查的。
4. `NODE_MODE=tarball` 时，`40-fetch-node.sh` 下载 `node-v22.23.3-linux-x64.tar.xz`（ARM 则是 `linux-arm64`），用镜像上的 `SHASUMS256.txt` 核对。
5. `50-make-bundle.sh` 用 `git archive` 打源码，把证书、`derper`、Node 包、安装脚本和模板放在一起，写 `MANIFEST` 和 `SHA256SUMS`。

成功后终端会打出包的路径和源码修订。自己确认包里没有私钥：

```sh
tar -tzf ~/.coflux-private-ca/out/coflux-private-centre.tar.gz | grep ca.key && echo '不该出现' || echo '包里没有 ca.key'
```

第二条没有输出、并打印「包里没有 ca.key」才对。`grep` 找不到时退出码是 1，这是预期。

## 3. 拷到 Debian 并安装

云安全组先放行 TCP `22`、TCP `8443`、TCP `8444`、UDP `3478`。不要放行 80、443、5432、8787、8793。主机上的 ufw 会再写一遍同样的规则。安装脚本在装 Caddy 之前就启用 ufw，因为 Caddy 的包装好就会去听 80。

把包拷上去。下面用 `203.0.113.10` 作占位，换成你的地址：

```sh
scp ~/.coflux-private-ca/out/coflux-private-centre.tar.gz root@203.0.113.10:/root/
```

在服务器上：

```sh
cd /root
umask 077
tar -xzf coflux-private-centre.tar.gz
cd coflux-private-centre
sha256sum -c SHA256SUMS
bash server/install.sh
```

`sha256sum` 每一行都要是 `OK`。`install.sh` 只接受 Debian，并且必须用 root。它按这个顺序做，中途失败就停：

1. `10-base.sh` 安装 curl、openssl、ufw、PostgreSQL、解压 Node 包要用的 xz。
2. `20-firewall.sh` 默认拒绝入站，放行上面四个端口，然后启用 ufw。SSH 端口来自 `site.conf` 的 `SSH_PORT`。先放行再启用，避免把自己锁在外面。
3. `30-node.sh` 把 Node 解到 `/opt/node`，链接到 `/usr/local/bin`。版本低于 22.13 会失败。`NODE_MODE=nodesource` 时才访问 NodeSource，大陆机器默认不要用这个。
4. `40-postgres.sh` 创建角色和库 `coflux`。密码用 `openssl rand -hex 24` 写到 `/etc/coflux/pg-coflux.pass`，权限 `0600`。密码从标准输入进 `psql`，不出现在 `-c` 参数里。再次安装会沿用这个密码，并 `ALTER ROLE` 成同一个值。然后检查 5432 只听在 `127.0.0.1` 和 `[::1]`。
5. `50-tls.sh` 建立组 `coflux-tls`，用户 `coflux` 和 `coflux-derp`。证书目录 `0750 root:coflux-tls`，私钥 `0640` 同组可读。Caddy 和 derper 都以普通用户运行，读得到私钥，其他用户读不到。`derper` 按主机名找证书，所以这里会做 `公网IP.crt` 和 `公网IP.key` 两个符号链接。
6. `60-app.sh` 把 `src.tar.gz` 解到 `/opt/coflux`，用 corepack 安装 pnpm 11.6.0，再 `pnpm install --frozen-lockfile`，registry 是 npmmirror。corepack 对镜像的签名校验失败时，脚本会关掉这次校验再试，仍失败才改用 `npm install -g pnpm@11.6.0`。
7. `70-env.sh` 生成 32 字节的 DERP 准入 token，写 `/etc/coflux/server.env` 和 `/etc/coflux/derp.env`，权限 `0600`。再次安装不换 token。`COFLUX_DERP_REGIONS` 用单引号包住，避免 `set -a; source` 把 JSON 拆碎。写完会 `JSON.parse` 一次。
8. `80-caddy.sh` 优先装 Cloudsmith 上的 Caddy。连不上就用 Debian 仓库里的包。装完立刻停掉它自带的 `:80` 站点，把 `caddy` 用户加进 `coflux-tls`，校验 Caddyfile，再重启。必须重启，新的组成员身份要到下次启动才生效。Caddy 关掉了 HTTP/3，这样 UDP 8443 不会被打开。
9. `90-services.sh` 安装 systemd 单元并启动。中心进程的用户是 `coflux`，只绑 `127.0.0.1:8787`。准入在 `127.0.0.1:8793`。`derper` 听 `:8444`，不是公网 IP：大陆云的公网地址一般是 NAT，网卡上没有这个地址，绑上去会 `cannot assign requested address`。STUN 跟着 `-a` 听 UDP `3478`。`-http-port -1` 让 derper 不要去绑 80。`-c` 不能不写，否则 derper 直接退出。`-verify-client-url-fail-open=false` 必须写，上游默认是问不到中心就给所有人中继。
10. `healthcheck.sh` 在本机用 `--connect-to` 打 `https://公网IP:8443/health`，避免从云主机访问自己的公网 IP（NAT 回环经常不通）。它还检查 `/client` 的 WebSocket 返回 101、`/derp/probe` 返回 200、不带 token 的准入是 403、未知节点是 `{"Allow":false}`，以及 80/443/5432/8787/8793 没有对公网监听。

环境文件里这几项是固定的，不要改成别的：

- `COFLUX_HOST=127.0.0.1`
- `COFLUX_AUTH=password`
- `COFLUX_PUBLIC_URL` 和 `COFLUX_DAEMON_URL` 带端口 `8443`
- `COFLUX_INBOUND_QUEUE_MAX_MESSAGES=1024`
- 不设 `COFLUX_DEV`
- 不设 GitHub / Google 登录。这两家的回调不接受裸 IP
- 不设 `COFLUX_AUTOUPDATE_REPO`。大陆上访问 `api.github.com` 不稳定，这台私有中心也不该自动推上游 runtime

`COFLUX_EXECUTOR_KEYS` 先不要加。加上之后不能再换掉，否则已经存下的执行器密钥读不出来。等设备真的能连上、并且你要在中心保存 API key 时再生成：

```sh
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
```

每天的数据库备份是 systemd timer `coflux-pg-backup.timer`，dump 在 `/var/backups/coflux`，留下 14 份。先 `pg_restore -l` 确认 dump 可读，再改名。不要把 `pg_dump` 和别的命令输出拼进同一条管道。

## 4. 建登录账号

在服务器上：

```sh
COFLUX_USER_EMAIL=you@example.com /usr/local/sbin/coflux-create-user
```

它从终端读密码，不回显。`scripts/create-user.mjs` 只接受命令行参数，所以密码会短时间出现在这台机器的进程列表里。这台机器不要给别人登录。

## 5. 在 Mac 上信任 CA，并检查

关掉 Surge 或别的 TUN。开着的时候 `nc` 会看到 `198.18.x.x`，端口看起来是通的，其实没到这台机器。

```sh
cd deploy/private-centre
client/mac-trust-ca.sh
client/mac-verify.sh
```

`mac-trust-ca.sh` 把 `ca.crt` 放进系统钥匙串。这覆盖 Safari、Chrome，以及桌面窗口里的页面。它不覆盖设备 runtime，也不覆盖 Rust 写的 `coflux`。macOS 自带的 `curl` 不一定读钥匙串，所以脚本用 `--cacert`。

`mac-verify.sh` 确认：带 CA 时 `/health` 是通的，不带 CA 时被拒绝，证书 SAN 是这个 IP，80/443/5432/8787/8793 从外网打不开，`stunc` 能从 UDP 3478 拿到你的公网地址。derper 自己的 STUN 绑定失败不会报错，所以这一步不能省。同一朵云里面的机器看不出大陆云对 80/443 的名字过滤，检查要从云外面做。

浏览器打开 `https://公网IP:8443/health`，装过 CA 之后不应再报警。

## 6. 编译自己的客户端

在 `private-centre` 分支、准备机上，CA 已经生成之后：

```sh
export COFLUX_BUILD_PUBLIC_ORIGIN=https://203.0.113.10:8443
export COFLUX_BUILD_CA_FILE="$HOME/.coflux-private-ca/ca.crt"
node scripts/write-private-build.mjs
cargo build --release -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd
```

`write-private-build.mjs` 把地址和 CA 写进 `packages/cli/private-build.local.json`，这个文件不入库。Cargo 在编译 Rust `coflux` 和 runtime 时读同样的两个环境变量。桌面打包时 `electron-vite` 也读它们，所以打包前这两个变量要还在：

```sh
pnpm --filter @coflux/desktop build
```

传输辅助程序按仓库里的 `node scripts/build-transport.mjs` 自己编，不要下作者的发布包。

这样编出来的程序：

- `cofluxd up` 不写 `--server` 时，默认是 `wss://公网IP:8443/daemon`
- `coflux login` 不写 `--server` 时，默认是 `https://公网IP:8443`
- 打包后的桌面默认打开 `wss://公网IP:8443/client`
- runtime、Rust `coflux`、Node 版 `cofluxd` 和桌面主进程都信任这把 CA
- `cofluxd up` 如果没有 `--bin-dir`，会拒绝去 `dl.coflux.dev` 下载。安装设备时用你刚编的目录：

```sh
node packages/cli/cofluxd.mjs up --bin-dir target/release
```

公网 IP 变了要改 `COFLUX_BUILD_PUBLIC_ORIGIN`，重新 `write-private-build.mjs`，再编一遍客户端。只换叶子、CA 没变、地址没变，不用重编。

## 7. 登记设备

用上面编出来的 `cofluxd`，不要用 `npm i -g cofluxd` 装到的那一份。`up` 打印的授权地址会落在你的 `https://公网IP:8443/authorize/...`。浏览器装过 CA 就能打开。桌面也用这次编出来的包，不要用从 `dl.coflux.dev` 下的正式版，那一份仍连作者的服务器，也会从作者的更新地址把自己换掉。

端口预览需要 `<短名>-<域名>` 这种主机名，这台只有 IP 的中心做不了。

## 换叶子和换地址

同一把 CA、同一个公网 IP，只是叶子到期或想换密钥：在 Mac 上再跑 `mac/20-issue-leaf.sh`，把新的 `server.crt`、`server.key`、`pin.txt` 放到一个目录，在服务器上执行：

```sh
/usr/local/sbin/coflux-rotate-leaf /路径
```

它会改 `/etc/coflux/server.env` 里的 `sha256-raw` 指纹，并重启 derper、Caddy 和中心。指纹是叶子证书正文的哈希，换叶子就一定变。客户端要等控制连接重新拿到区域配置之后，DERP 才认新指纹。

换过叶子之后，不要再用旧物料包重跑 `install.sh`，那会把旧叶子装回去。

公网 IP 变了：改 `site.conf` 的 `PUBLIC_IP`，重新 `mac/prepare.sh`（CA 还在，不会重建），把新包拷上去再跑 `install.sh`。数据库密码和准入 token 会留着。SAN、`COFLUX_PUBLIC_URL`、`COFLUX_DAEMON_URL`、DERP 的 `HostName` 和 `IPv4`、证书文件名、Caddy 的 `default_sni` 一起换成新地址。已经装进钥匙串的 CA 不用换。

825 天到期前要换叶子。CA 本身是 10 年。

## 再跑一次安装

`install.sh` 可以重放。它会重新解源码、重新 `pnpm install`、按当前物料包重写 Caddyfile 和环境文件。`/etc/coflux/pg-coflux.pass` 和 `/etc/coflux/derp-admission.token` 已存在就继续用。手改过的 `server.env` 会被模板盖掉。

以后检查：

```sh
/usr/local/sbin/coflux-healthcheck
journalctl -u coflux-server -u coflux-derp -u caddy -n 80 --no-pager
```

`coflux-derp` 日志里如果是 `verify-client-url` 连不上，中继会拒绝所有人。控制面的 `/health` 这时仍然是好的。
