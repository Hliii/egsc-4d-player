# EGSC 4D Player 手机部署指南（PWA 全离线）

## 方案

PWA（Service Worker + Web App Manifest）：首次访问在线加载后，全部资源
（~30 个 ES 模块 + 144KB wasm + 24.5MB 场景）缓存进浏览器存储，
之后**零网络可用**，可“安装”到主屏幕独立运行。

- `sw.js`（player 根目录）：appshell 预缓存 + 场景首次抓取缓存 + cache-first
  （HTML 用 network-first 保更新）
- `egsc-pwa/manifest.json`：standalone 显示、深色主题、图标（SVG + 192/512 PNG）
- `examples/egsc-demo.html`：注册 SW、预热场景、状态栏显示 "offline ready"

⚠️ **必须 HTTPS**（或局域网内 localhost）：SW 与“安装到主屏”都要求安全上下文。
python `http.server` 仅用于 PC 开发（127.0.0.1 是安全上下文例外）；
手机必须 HTTPS。

## 部署三步

### 1. 准备静态服务器（任选其一）

**nginx（推荐，自有服务器）：**
```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;
  root /var/www/egsc-player;   # player/ 目录内容
  location / { try_files $uri $uri/ =404; }
  # 大文件缓存友好头（可选）
  location ~ \.(egsc|wasm)$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

**Node 一行服务器（无 nginx 时）：**
```bash
node egsc_4d_eval/static_server.mjs <player目录> 8443   # 前置任意 TLS 反代
```

上传内容 = `FreeTimeGsVanilla/player/` 整目录（src/、examples/assets/scene.egsc、
sw.js、egsc-pwa/、site/ 可选）。

### 2. 手机安装

手机浏览器（Android Chrome / iOS Safari 16.4+）打开：
```
https://your.domain.com/examples/egsc-demo.html
```
- 等状态栏出现 `offline ready`（首次会把 24.5MB 场景写入缓存）
- Android：菜单 → **“安装应用”** / “添加到主屏幕”
- iOS：分享 → **“添加到主屏幕”**

### 3. 验证离线

开启飞行模式（或断开 WiFi）→ 从主屏图标打开 → 场景正常加载播放。

## PC 验证结果（已完成）

| 项 | 结果 |
|---|---|
| SW 注册/激活 | controller=true, state=activated |
| 缓存 | 28 项（全部模块/wasm/**scene.egsc**） |
| **断网重载（CDP offline 模拟）** | `ready — 678,832 Gaussians`，解码 **1.79s**（缓存命中快于网络） |
| 离线播放 | playing=true，1s 推进 0.331 归一化时间 |
| 在线 e2e | 2.05s 正常 |

## 维护注意

- **升级资源**：改任何文件后递增 `sw.js` 里的 `CACHE = "egsc-4d-v1"` 版本号，
  用户下次访问自动换缓存（旧缓存 activate 时清除）。
- **iOS SW 生命周期**：Safari 对 14 天未访问的 SW 可能清理；用户重访一次即恢复。
- **换场景**：替换 `examples/assets/scene.egsc` + bump CACHE 版本。
- 已知限制：SW scope 必须覆盖 `/`（sw.js 已放在 player 根目录，
  若站点把 player 挂在子路径如 `https://x.com/player/` 下也天然成立）。
