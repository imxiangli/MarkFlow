# MarkFlow 更新服务器：要求与部署

MarkFlow 的更新服务器就是一个**只读的静态文件目录**。不需要后端程序、数据库或登录，只要能通过 HTTP(S) 下载文件就行。下面先说明它需要满足的要求，再给出四种部署方式，以及每次发版的操作步骤。

---

## 1. 服务器要求

| 项目 | 要求 |
| --- | --- |
| 服务类型 | 静态文件托管（HTTP GET / HEAD）。不需要数据库、后端接口、CORS 或断点续传 |
| 访问地址 | 一个固定的目录地址，例如 `https://updates.example.com/markflow/`（末尾的 `/` 可省略） |
| HTTPS | **强烈建议**。文件完整性由签名保证，被篡改的更新会被拒绝；HTTPS 额外防止劫持和窥探 |
| `.gz` 文件 | 必须**原样返回**，不能被服务器解压或重新压缩。客户端能容忍 `Content-Encoding: gzip`，但最好不要加 |
| 缓存 | `latest.json`、`latest.json.sig` 设为 `Cache-Control: no-cache`；`files/`、`versions/`、`full/` 下的文件可以永久缓存（`max-age=31536000, immutable`） |
| 硬件 | 1 核 / 512 MB 内存的 Linux 小主机就够了；也可以直接用对象存储加 CDN |
| 存储空间 | 首次约 4.4 MB 程序文件，加上各平台安装包（每个约 120–150 MB）。之后每个版本只增加变化的文件（通常几十 KB 到 1 MB）；只有升级 Electron 时才会新增安装包 |
| 带宽 | 每台电脑每次增量更新约 30 KB–2 MB；升级 Electron 时每台约 130 MB |
| 上传方式 | SSH / rsync，或对象存储的上传工具（ossutil、coscli、aws 等） |

> **中国大陆服务器**：域名通过 80/443 端口提供网站服务，需要先完成 ICP 备案。如果暂时没有备案，可以用香港或海外节点，或者走对象存储默认分配的域名。

### 目录结构

由 `npm run release:update` 生成，在 `release/update/` 下：

```
markflow/                  ← 应用里配置的更新地址指向这里
├── latest.json            当前版本的清单（版本号、Electron 版本、文件列表和哈希）
├── latest.json.sig        latest.json 的 Ed25519 签名
├── versions/
│   ├── 1.0.0.json         每个版本清单的存档（与当时的 latest.json 完全相同）
│   └── 1.0.0.json.sig     不可变的签名，客户端优先读取它
├── files/
│   └── <sha256>.gz        按内容哈希存储的程序文件（同一份内容只存一次）
└── full/
    └── 1.0.0/…            各平台完整安装包（只在 Electron 版本变化时会被下载）
```

**上传顺序很重要**：先上传 `files/`、`versions/`、`full/`，最后再上传 `latest.json.sig` 和 `latest.json`。`scripts/deploy-update.mjs` 会自动按这个顺序上传。如果中途失败，客户端仍然看到上一个版本，不会出错。

---

## 2. 部署方式

### 方式 A：云服务器 + Docker + Caddy（推荐，自动申请 HTTPS 证书）

适合有一台 Linux 云服务器和一个域名的情况。配置文件在 [`server/`](../server)。

1. **域名**：添加一条 A 记录，比如 `updates.example.com`，指向服务器的公网 IP。
2. **防火墙 / 安全组**：放行 TCP 80 和 443。
3. **在服务器上安装 Docker**（Ubuntu / Debian）：
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. **把 `server/` 目录复制到服务器**（在本机执行）：
   ```bash
   rsync -a server/Caddyfile server/docker-compose.yml deploy@updates.example.com:/opt/markflow-update/
   ```
5. **启动服务**（在服务器上执行）：
   ```bash
   cd /opt/markflow-update
   mkdir -p data
   MARKFLOW_SITE=updates.example.com docker compose up -d
   docker compose ps          # 状态应显示 healthy
   ```
   Caddy 会自动申请和续期 Let's Encrypt 证书。日志用 `docker compose logs -f` 查看。
6. **首次发布**（在本机执行）：
   ```bash
   npm run build
   npm run release:update -- --notes "首个版本"
   node scripts/deploy-update.mjs deploy@updates.example.com:/opt/markflow-update/data
   node scripts/verify-update-server.mjs https://updates.example.com/markflow/
   ```
7. **配置客户端**：见第 4 节。

### 方式 B：已有 nginx

使用 [`server/nginx/markflow-update.conf`](../server/nginx/markflow-update.conf)：

- 如果服务器上已经有一个配置好 HTTPS 的站点，就把文件里的两个 `location` 块复制进那个站点的 `server { … }`。
- 如果没有，把整个文件放到 `/etc/nginx/conf.d/`，修改 `server_name`，再配置证书（例如 `certbot --nginx`）。

然后：

```bash
sudo mkdir -p /srv/markflow && sudo chown deploy /srv/markflow
sudo nginx -t && sudo systemctl reload nginx
node scripts/deploy-update.mjs deploy@your-server:/srv/markflow      # 在本机执行
node scripts/verify-update-server.mjs https://your-domain/markflow/
```

这份配置会关闭 `.gz` 的再压缩、设置好两类缓存头，并拦截目录外的路径。

### 方式 C：对象存储 + CDN（阿里云 OSS、腾讯云 COS、AWS S3、Cloudflare R2…）

不需要维护服务器，最省心。

1. 创建一个存储桶，权限设为**公共读**（或私有桶加 CDN 回源）。
2. 按“先内容、后清单”的顺序上传，并设置缓存头。下面以 AWS CLI 为例；它也兼容 R2、MinIO 以及阿里云 OSS、腾讯云 COS 的 S3 兼容接口，加上 `--endpoint-url` 参数即可：
   ```bash
   B=s3://your-bucket/markflow
   IMMUTABLE="public, max-age=31536000, immutable"
   aws s3 sync release/update/files    $B/files    --cache-control "$IMMUTABLE"
   aws s3 sync release/update/versions $B/versions --cache-control "$IMMUTABLE"
   aws s3 sync release/update/full     $B/full     --cache-control "$IMMUTABLE"
   aws s3 cp release/update/latest.json.sig $B/latest.json.sig --cache-control "no-cache" --content-type "text/plain"
   aws s3 cp release/update/latest.json     $B/latest.json     --cache-control "no-cache" --content-type "application/json"
   ```
   阿里云原生工具 ossutil 的写法与之类似：`ossutil cp -r release/update/files oss://bucket/markflow/files --update --meta "Cache-Control:public, max-age=31536000, immutable"`。最后两步对 `latest.json.sig` 和 `latest.json` 使用 `--meta "Cache-Control:no-cache"`。
3. 如果套了 CDN：给 `latest.json*` 配置“不缓存”或很短的缓存时间，并**关闭对 `.gz` 的智能压缩或格式转换**。
4. 用存储桶或 CDN 的地址运行校验：`node scripts/verify-update-server.mjs https://cdn.example.com/markflow/`。

> 单个安装包约 130 MB。有些托管平台限制单文件 100 MB（例如 GitHub Pages），不适合存放安装包。

### 方式 D：Node.js 服务 + systemd（不使用 Docker）

[`server/update-server.mjs`](../server/update-server.mjs) 是一个零依赖的静态服务器，已经设置好正确的响应头，只需要 Node.js 18 或更高版本。

```bash
sudo mkdir -p /opt/markflow-update /srv/markflow
sudo cp server/update-server.mjs /opt/markflow-update/
sudo cp server/markflow-update.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now markflow-update
curl http://127.0.0.1:8080/healthz          # ok
```

它只监听 `127.0.0.1:8080`，前面再放一个 Caddy 或 nginx 负责 HTTPS（反向代理到 `http://127.0.0.1:8080`）。也可以直接运行：`node server/update-server.mjs --root /srv/markflow --port 8080`。

---

## 3. 每次发布新版本

```bash
# 1. 修改 package.json 中的 version，例如 1.0.1
npm run build
# 2. 只有升级了 Electron 时才需要：npm run dist:mac / dist:win / dist:linux（或交给 CI）
npm run release:update -- --notes "修复了图片显示问题"
node scripts/deploy-update.mjs <上传目标>
node scripts/verify-update-server.mjs <更新地址>
```

- `release:update` 会打印本次更新需要下载的大小，例如 `update from 1.0.0: 1 changed files, 0.03 MB`。
- 一直使用同一个 `release/update/` 目录：文件按哈希去重，旧版本的文件也会保留，正在更新中的客户端不受影响。
- CI 中的 `update-feed` 任务会自动生成这个目录。它需要在 GitHub 仓库的 Secrets 中配置 `MARKFLOW_UPDATE_KEY`，值为 `keys/update-private.pem` 的内容。

### 回滚

客户端只会升级、不会降级。如果某个版本有问题，就用修复后的（或旧的）代码发布一个**更高的版本号**，比如 1.0.3。

另外，如果新版本在用户电脑上连续两次没能启动，应用会自动退回安装包自带的版本，并且不再下载这个版本。

---

## 4. 配置客户端

更新地址按以下优先级读取：

1. 环境变量 `MARKFLOW_UPDATE_URL`（用于测试）
2. 应用内「设置 → 更新 → 更新服务器地址」（只对当前用户生效）
3. `package.json` 中的 `"markflow": { "updateUrl": "https://updates.example.com/markflow/" }`。这个地址会打包进安装包，作为默认值

正式发布前，先在第 3 项填好地址，然后重新打安装包分发出去。之后的版本都可以通过增量更新送达。

---

## 5. 安全

- 客户端内置了 `src/main/update-public-key.ts` 中的公钥，只接受由对应私钥签名的清单。清单里记录了每个文件的 SHA-256，下载后会逐个核对。
- **私钥 `keys/update-private.pem` 必须妥善备份，不要提交到代码仓库**（`.gitignore` 已经排除）。一旦丢失，已安装的客户端将无法再接受任何更新，只能重新发布安装包。
- 如果需要更换密钥：生成新密钥（`npm run update:keygen -- --force`），重新打包并发布**完整安装包**。旧客户端需要手动安装新版本。

---

## 6. 本地试运行

不需要域名，几分钟就能在本机看到效果：

```bash
npm run build && npm run release:update
node scripts/deploy-update.mjs server/data
cd server && MARKFLOW_SITE=:80 MARKFLOW_HTTP_PORT=127.0.0.1:8088 MARKFLOW_HTTPS_PORT=127.0.0.1:8443 docker compose up -d
node ../scripts/verify-update-server.mjs http://127.0.0.1:8088/markflow/
# 停止：docker compose down
```

打包好的应用可以这样指向本地服务器测试：
`MARKFLOW_UPDATE_URL=http://127.0.0.1:8088/markflow/ /Applications/MarkFlow.app/Contents/MacOS/MarkFlow`

---

## 7. 常见问题

| 现象（应用内提示） | 原因与处理 |
| --- | --- |
| 尚未配置更新服务器地址 | 第 4 节的三个地方都没有设置地址 |
| HTTP 404 …/latest.json | 地址缺少 `/markflow/` 前缀，或者文件没有上传到对应目录 |
| Update manifest signature is invalid | 用错了私钥签名；或者 `latest.json` 在上传后被修改过，比如 CDN 做了格式化。用 `deploy-update.mjs` 重新上传 |
| Checksum mismatch | CDN 或服务器改动了 `.gz` 文件（例如图片压缩或格式转换）。关闭相关优化后，运行 `verify-update-server.mjs` 确认 |
| 一直提示需要“完整安装包” | 新版本升级了 Electron；或者增量版本曾在这台电脑上启动失败、被标记过。可以查看用户数据目录里的 `updates/state.json` |
| 新版本发布后很久才被发现 | `latest.json` 被 CDN 缓存了。设置为 `no-cache`；客户端每 6 小时检查一次，也可以手动“检查更新” |
