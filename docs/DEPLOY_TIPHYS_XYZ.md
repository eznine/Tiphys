# tiphys.xyz 怎么上线

**读这一段就够。** tiphys.xyz 的公网站点不是 Cloudflare Pages，也不用 `wrangler`。

| 角色 | 是什么 |
| --- | --- |
| 域名 / CDN | Cloudflare（只代理 DNS + HTTPS） |
| 真正的源站 | `eznine@20.214.241.113` 上的 nginx，网站根目录 `/srv/tiphys-web` |
| 上线动作 | 本地 `npm run build` → 把 **`dist/` 内容** 同步进 `/srv/tiphys-web` |

推 GitHub **不会**自动更新 tiphys.xyz。没有 Cloudflare token、没有 Pages 项目、没有 `wrangler login` 都正常，**不要**去找这些。

---

## 一键部署（推荐）

仓库里有脚本，在能 SSH 到源站的机器上跑：

```bash
# Linux / 本 bot 共享电脑
npm run build
npm run deploy:xyz
# 或直接：
bash scripts/deploy-tiphys-xyz.sh
```

```powershell
# Windows（家用 PC）
npm run build
npm run deploy:xyz
# 或：
powershell -NoProfile -File scripts\deploy-tiphys-xyz.ps1
```

脚本会：用密钥登录 → 把 `dist/` 传到服务器 `/tmp/tiphys-dist` → `sudo` 同步进 `/srv/tiphys-web`（直接写 `/srv` 会权限失败，必须经 `/tmp`）。

### 凭据放哪里（禁止进 Git）

| 环境 | SSH 私钥 | sudo / 登录密码文件 |
| --- | --- | --- |
| Windows 家用 PC | `F:\server\eznine_deploy_b` | `F:\server\tiphys-deploy-pass.txt`（一行明文） |
| Linux 共享电脑 | 已配好的 `~/.ssh` 或环境变量 | 环境变量 `EZNINE_SSH_PASSWORD`，或 `~/.config/tiphys/deploy.env`（gitignored） |

也可以临时：

```bash
export EZNINE_SSH_HOST=20.214.241.113
export EZNINE_SSH_USER=eznine
export EZNINE_SSH_KEY=/path/to/eznine_deploy_b
export EZNINE_SSH_PASSWORD='…'   # 仅用于远端 sudo；不要写进仓库
bash scripts/deploy-tiphys-xyz.sh
```

**报「找不到密钥 / No token」时：** 不是 Cloudflare 的事。去上表路径找 `eznine_deploy_b` 和 `tiphys-deploy-pass.txt`，或设 `EZNINE_SSH_*`。本仓库永远不存密码、不存私钥。

---

## 手写命令（脚本坏了时对照）

```bash
npm ci && npm run build

# 有 rsync + sshpass 时：
export SSHPASS="$(cat …/tiphys-deploy-pass.txt)"   # 或已导出的 EZNINE_SSH_PASSWORD
sshpass -e rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  dist/ eznine@20.214.241.113:/tmp/tiphys-dist/
sshpass -e ssh -i "$KEY" -o StrictHostKeyChecking=no eznine@20.214.241.113 \
  "printf '%s\n' \"$SSHPASS\" | sudo -S rsync -a --delete /tmp/tiphys-dist/ /srv/tiphys-web/"
```

Windows 若没有 `rsync`，用仓库脚本（内部 tar-over-ssh，效果等同 `--delete`），不要自己发明 `wrangler pages deploy`。

---

## 构建产物

```bash
npm ci
npm run build
```

上传的是仓库根目录 **`dist/` 里面的内容**（不要把 `dist` 这一层目录名本身当成站点子路径）：

```text
dist/
  index.html
  logo-temp.png
  samples/…
  licenses/…
  assets/*.js | *.css | *.wasm | maplibre-gl-worker-*.js
```

- 站点必须挂在域名根路径 `/`。
- 不要改 `assets/` 里带 hash 的文件名。MapLibre worker 必须是 **`.js` + JavaScript MIME**；若被当成 `application/octet-stream` 或仍用上游 `.mjs`，地图会飞过去但一片空白。
- nginx 参考：`deploy/nginx-tiphys.conf`（`index.html` no-cache，hashed assets 长缓存，`.wasm` → `application/wasm`，`/version.json` + `/apk/` 短缓存与 CORS）。`npm run deploy:xyz` 会尝试安装该配置并 `nginx -t && reload`。

---

## Cloudflare 只做什么

Cloudflare 管 DNS（`tiphys.xyz` / `www` → `20.214.241.113`，橙云代理）和 HTTPS。`cf-cache-status: DYNAMIC` 正常。

**当前不要：**

- `npx wrangler pages deploy`
- 等 Pages Git 构建
- 因为没有 Cloudflare API token 就停住

以后若改成 Pages 做源站，再另开文档；那不是现状。

---

## 上线后核对

1. `curl -s https://tiphys.xyz/ | grep -oE 'assets/index-[^"]+\.js'` 应等于本地 `dist/index.html` 里的同名文件。
2. 浏览器强刷打开 tiphys.xyz：地球、底图、蓝浅色主题。
3. 空地图态点「加载示例点位」（不需要 API key），应能看见点和底图。
4. `curl -I` 检查 `maplibre-gl-worker-*.js` 是 JavaScript，`geolibre-cli-*.wasm` 是 `application/wasm`。

## API 密钥与 GEE

- 模型 key 由用户在浏览器里填，进 IndexedDB；不要打进静态包。
- 不要把 GEE 服务账号放进 web 根目录。
