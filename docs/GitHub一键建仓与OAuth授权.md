# 一键创建私有仓库 + OAuth Device Flow：实施教程

> 关联：`README.md` 的「把 GitHub 私有仓库当「数据库」」、`docs/GitHub私有仓库令牌配置.md`（手动 PAT 路线）
> 目标：把「注册 GitHub 账号 → 建私有仓库 → 生成 Fine-grained 令牌 → 回调填 6 个字段」压缩成
> **点一下 → 输入 8 位验证码 → 授权 → 自动建仓库并填好配置**。
> 状态：**本页是方案与实施步骤，功能尚未写进代码**。现有手动 PAT 流程保持不变，本方案是可选降级之上的"快车道"。

---

## 1. 这个方案解决什么

现有流程（`docs/GitHub私有仓库令牌配置.md`）对懂 GitHub 的人没问题，但分发给非技术用户时，流失点集中在三处：

| 卡点 | 现状 | 一键方案后 |
| --- | --- | --- |
| 建私有仓库 | 用户自己去 GitHub 网页建，还得勾 README 初始化 | 页面调 `POST /user/repos` 自动建（`private: true` + `auto_init: true`） |
| 生成 Fine-grained 令牌 | 要选仓库、勾 Contents: Read and write、设过期、复制 | 不需要，改用 OAuth 授权拿 token |
| 回填 6 个字段 | owner / repo / branch / path / token / 口令 | 自动写入 `localStorage`，用户只需决定要不要设加密口令 |
| 令牌 90 天过期 | 到期报 401，用户不会自己换 | OAuth token 长期有效，可随时在 GitHub 撤销 |

**代价（必须让用户知情）**：OAuth App 没有仓库级细粒度权限，`repo` scope 等于"该账号下所有私有仓库可读写"，比 Fine-grained 单仓库令牌宽。见第 7 节。

---

## 2. 为什么能纯前端做：Device Flow 原理

Device Flow 是为"没有浏览器/没有回调地址"的设备设计的授权流程，**不需要 `client_secret`，不需要 `redirect_uri` 回跳**，因此静态站点可以完整跑完。GitHub 的这两个端点带 CORS 头，浏览器 `fetch` 可直连。

```
用户                页面（静态站）                        GitHub
 |  点「一键创建」        |                                  |
 |---------------------->|  POST /login/device/code          |
 |                      |  {client_id, scope:"repo"}        |
 |                      |--------------------------------->|
 |                      |  {device_code, user_code,         |
 |                      |   verification_uri, interval}     |
 |  看到 "ABCD-1234"     |<---------------------------------|
 |  在 github.com/login/device 输入并点授权                  |
 |-------------------------------------------------------->|
 |                      |  每 5 秒 POST /login/oauth/access_token
 |                      |  {client_id, device_code, grant_type}
 |                      |--------------------------------->|
 |                      |  pending → ... → {access_token}   |
 |                      |<---------------------------------|
 |  自动建仓库 + 写配置文件 + 保存 token 到本机              |
```

关键事实：

- `POST https://github.com/login/device/code` → 返回 `device_code`、`user_code`（形如 `WDJB-MJHT`）、`verification_uri`（`https://github.com/login/device`）、`expires_in`（900 秒）、`interval`（通常 5 秒）
- `POST https://github.com/login/oauth/access_token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`
- 轮询期间的业务错误（HTTP 仍是 200）：`authorization_pending`（继续等）、`slow_down`（间隔 +5 秒）、`expired_token`、`access_denied`
- 必须带 `Accept: application/json`，否则 GitHub 返回 `application/x-www-form-urlencoded`
- OAuth App 设置里必须勾 **Enable device flow**，否则 `device/code` 直接报错
- 只在 **HTTPS**（或 `localhost`）下可用，GitHub Pages 天然满足

> 参考：<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>

---

## 3. 一次性准备：注册 OAuth App（只做一次，站点维护者做）

1. 打开 <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**
2. 填写：

| 字段 | 填什么 |
| --- | --- |
| Application name | `股票秘书` |
| Homepage URL | 你的 Pages 地址，如 `https://<user>.github.io/stock-advisor/` |
| Authorization callback URL | 同上（Device Flow **不使用**它，但必填） |
| **Enable Device Flow** | **必须勾选** |

3. 创建后在应用详情页复制 **Client ID**（形如 `Ov23li...`）
4. **不要**生成/使用 Client Secret：本方案是公共客户端，secret 放进前端等于泄露
5. 把这个 Client ID 注入构建：

```yaml
# .github/workflows/pages.yml → build 步骤 env 里加一行
VITE_GITHUB_CLIENT_ID: ${{ vars.GITHUB_OAUTH_CLIENT_ID }}
```

在仓库 `Settings → Secrets and variables → Actions → Variables` 新建变量 `GITHUB_OAUTH_CLIENT_ID`。
本地开发时 `web/.env.local` 写 `VITE_GITHUB_CLIENT_ID=Ov23li...`。

> Client ID 是公开信息，写进源码/构建变量都安全。**没有它**时，页面必须自动隐藏「一键创建」按钮、回退现有手动 PAT 面板——这是分发给别人的必备降级逻辑。

---

## 4. 代码落点

新增两个文件，改三处地方：

```
web/src/services/
├── github-api.js        （不改）只会读写文件
├── github-sync.js       （改）配置与状态存储、自动推送
├── github-oauth.js      （新）Device Flow：申请验证码 + 轮询换 token
└── github-provision.js  （新）建仓库 + 写首份数据 + 组装配置
web/src/components/GitHubSyncPanel.vue  （改）加「用 GitHub 账号一键创建」区块
.github/workflows/pages.yml             （改）注入 VITE_GITHUB_CLIENT_ID
```

### 4.1 `github-oauth.js`

```js
const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID || '';
const SCOPE = 'repo'; // 建私有仓库 + 写文件的最小 OAuth scope（仍偏大，见第 7 节）
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export const oauthAvailable = () => !!CLIENT_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ① 申请验证码：返回 { device_code, user_code, verification_uri, expires_in, interval } */
export async function startDeviceFlow() {
  if (!CLIENT_ID) throw new Error('未配置 VITE_GITHUB_CLIENT_ID，请使用手动令牌方式');
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}：请确认 OAuth App 已勾选 Enable device flow`);
  return res.json();
}

/** ② 轮询换 token；onPending 用于刷新 UI 上的"等待授权中…" */
export async function pollForToken({ device_code, interval = 5, expires_in = 900 }, onPending) {
  const deadline = Date.now() + expires_in * 1000;
  let wait = Math.max(interval, 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.access_token) return { token: body.access_token, scope: body.scope || '' };
    if (body.error === 'authorization_pending') { onPending?.(); continue; }
    if (body.error === 'slow_down') { wait += 5000; onPending?.(); continue; }
    if (body.error === 'expired_token') throw new Error('验证码已过期（15 分钟），请重新点击「一键创建」');
    if (body.error === 'access_denied') throw new Error('你取消了授权');
    throw new Error(body.error_description || body.error || '授权失败');
  }
  throw new Error('等待授权超时，请重新点击「一键创建」');
}
```

### 4.2 `github-provision.js`

```js
import * as gh from './github-api.js'; // 复用 writeFile / normalizePath

const API = 'https://api.github.com';
const H = (token) => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

/** 取当前账号 login，并检查授权范围是否含 repo */
export async function whoAmI(token) {
  const res = await fetch(`${API}/user`, { headers: H(token) });
  if (!res.ok) throw new Error(`无法读取 GitHub 账号信息（${res.status}）`);
  const scopes = res.headers.get('x-oauth-scopes') || '';
  if (!scopes.split(',').map((s) => s.trim()).includes('repo')) {
    throw new Error('授权时未勾选 repo 权限，无法创建私有仓库；请在 GitHub 设置里撤销后重新授权');
  }
  const me = await res.json();
  return { login: me.login, hasRepoScope: true };
}

/** 已存在就直接复用；不存在则建私有仓库（auto_init 让仓库自带 main 分支，避开空仓库 422） */
export async function ensurePrivateRepo(token, owner, name) {
  const exists = await fetch(`${API}/repos/${owner}/${name}`, { headers: H(token) });
  if (exists.ok) {
    const r = await exists.json();
    if (!r.private) throw new Error(`已存在同名仓库 ${owner}/${name}，但它是公开的，请改名或先删掉`);
    return { repo: r, created: false };
  }
  const res = await fetch(`${API}/user/repos`, {
    method: 'POST',
    headers: { ...H(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: true,
      auto_init: true, // 关键：自动建 README + 默认分支，否则首次写文件会 422
      description: '股票秘书数据（请勿设为公开）',
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`创建仓库失败（${res.status}）${body.message ? `：${body.message}` : ''}`);
  }
  return { repo: await res.json(), created: true };
}

/**
 * 完整一键流程。
 * @param {(step:string)=>void} onProgress 进度回调，用于面板显示
 * @param {string} [repoName] 默认 stock-advisor-data
 */
export async function provision(token, { repoName = 'stock-advisor-data', onProgress } = {}) {
  onProgress?.('读取账号信息…');
  const me = await whoAmI(token);

  onProgress?.('创建私有仓库…');
  const { repo, created } = await ensurePrivateRepo(token, me.login, repoName);

  return {
    created,
    config: {
      owner: me.login,
      repo: repo.name,
      branch: repo.default_branch || 'main',
      path: 'stock-advisor-data.json',
      token,
    },
  };
}
```

### 4.3 保存配置并首次上传

不需要新接口，直接复用现有 `github-sync.js`：

```js
import { githubSync } from '../services/dataSource.js';

githubSync.saveConfig({ owner, repo, branch, path, token, passphrase: pwd, autoPush: true });
const test = await githubSync.testConnection(githubSync.loadConfig());
if (!test.private) throw new Error('仓库不是私有的，已中止');
await githubSync.push({ reason: '一键配置：首次上传', force: true });
```

注意顺序：**先 `saveConfig` 再 `testConnection`**，因为 `testConnection(cfg)` 默认读 `loadConfig()`。

---

## 5. 面板交互怎么改（`GitHubSyncPanel.vue`）

在现有「三步引导」上方插一个可选区块，未配置 `VITE_GITHUB_CLIENT_ID` 时整块 `v-if` 隐藏：

```
┌──────────────────────────────────────────────┐
│ ☁️ 同步到 GitHub 私有仓库         [待首次同步] │
│                                              │
│ ┌ ✅ 推荐：用 GitHub 账号一键创建（约 20 秒） ┐ │
│ │ [ 一键创建私有仓库 ]                       │ │
│ │  → 页面显示验证码  ABCD-1234  [复制] [打开]│ │
│ │  → 在 GitHub 输入并点 Authorize 后自动继续 │ │
│ └────────────────────────────────────────────┘ │
│ 或者手动填写：①用户名/仓库 ②令牌 ③测试连接     │
└──────────────────────────────────────────────┘
```

状态机（一个 `phase` ref 就够）：

| phase | 界面 |
| --- | --- |
| `idle` | 显示「一键创建私有仓库」按钮 |
| `waiting` | 显示 `user_code`（大字号 + 复制按钮）+「打开 github.com/login/device」+「等待授权中…」+ 取消按钮 |
| `provisioning` | 显示 `onProgress` 文案（读取账号 → 创建仓库 → 上传数据） |
| `passphrase` | 建仓成功后弹出：请输入加密口令（可留空），确认后才首次上传 |
| `done` | 顶部成功提示 + 自动填充表单 + `testResult` 就绪，可直接「双向同步」 |

实现要点：

- `user_code` 建议显示为 `XXXX-XXXX` 并支持点击复制（`navigator.clipboard.writeText`）
- 换取 token 的轮询必须可取消：保存一个 `cancelRef`，用户关面板/点取消时置位，循环里检查后 `return`
- 成功后 `emit('changed')` 并 `emit` 一次让父组件刷新持仓
- 口令这一步不能省：`saveConfig` 的 `passphrase` 传 `''` 就是明文上传，UI 必须显式让用户选择

---

## 6. 错误对照表（补到 `github-api.js: friendlyError` 之外）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `GitHub 返回 404：请确认 OAuth App 已勾选 Enable device flow` | OAuth App 没开 Device Flow | 去应用设置勾上 |
| 轮询一直 `authorization_pending` | 用户还没点 Authorize | 正常，继续等；提示文案要明显 |
| `slow_down` 反复出现 | 轮询太快 | 每次 +5 秒，别缩短间隔 |
| `expired_token` | 超过 15 分钟 | 重新点「一键创建」 |
| `access_denied` | 用户点了 Cancel | 提示可重试，不要报红错 |
| `授权时未勾选 repo 权限` | 授权页取消了默认勾选 | 撤销授权后重来（`x-oauth-scopes` 检测） |
| `创建仓库失败（422）：name already exists` | 同名仓库已存在于其他位置 | 换名字，或走"复用已有私有仓库"分支 |
| `已存在同名仓库，但它是公开的` | 撞名公开仓库 | 强制改名，不能复用 |
| `403 GitHub API 触发了限流` | 5000 次/小时 | 等重置时间 |

---

## 7. 安全边界（必须写进 UI 文案）

| 项 | OAuth Device Flow | 现有 Fine-grained PAT |
| --- | --- | --- |
| 权限范围 | `repo`：**该账号所有私有仓库**可读写 | 仅指定的一个仓库 Contents |
| 有效期 | 长期，直到撤销 | 90 天（可设） |
| 用户操作成本 | 一次授权点击 | 建仓库 + 建令牌 + 填 4 个字段 |
| 泄露风险 | 更大（impact 面广） | 更小 |
| 撤销入口 | <https://github.com/settings/applications> | 令牌列表 |

结论与约定：

1. **两条路都保留**：一键方案是"快车道"，手动 PAT 是"最小权限"选项。面板文案要明确告知 `repo` 范围，不做隐藏。
2. 页面不得引入任何第三方脚本（统计/广告/字体 CDN）。token 存在 `localStorage`（`stock-advisor:github-config`），静态站唯一防线是"没有可注入的外部代码"。
3. 加密口令仍然可选且强烈建议：拿到 token 的人即使进仓库，看到的也只是 AES-GCM 密文。
4. 建议在授权成功页加一句：「授权后随时可在 GitHub → Settings → Applications 撤销」。
5. 更细粒度的未来路线：GitHub App + user-to-server token 可以做仓库级安装，但 App 不能代用户创建个人仓库，且需要回调/服务端换取 token —— 留作后续优化，不要现在做。

---

## 8. 自测清单

- [ ] 未配置 `VITE_GITHUB_CLIENT_ID` 时，面板不出现一键区块，手动 PAT 流程完全不受影响
- [ ] 点击一键创建 → 显示 8 位验证码，5 秒内点击「打开」跳到 `github.com/login/device`
- [ ] 在 GitHub 输入验证码并 Authorize → 页面 5–10 秒内自动完成建仓
- [ ] 建仓后 `Settings` 里仓库是 **Private**，且已有默认分支（`main`）
- [ ] 云端出现 `stock-advisor-data.json`，内容是信封（或密文）
- [ ] 第二台设备授权同一个账号 → 复用已有仓库，不重复创建，拉取到同一份数据
- [ ] 中途点「取消」：轮询停止，无后续请求（Network 面板确认）
- [ ] 刷新页面后配置仍在（`localStorage` 有 `stock-advisor:github-config`）
- [ ] GitHub 撤销应用授权后，页面「测试连接」报 401 且文案友好
- [ ] 子路径部署（`/<repo>/`）下流程照常，`npm run check:pages` 仍通过

> 端到端验证建议照着现有脚本的写法加一个 `check:oauth`（拦 `login/device/code`、`login/oauth/access_token`、`api.github.com` 三个端点，用假响应跑完整流程），与 `sync-check.mjs` 同构。

---

## 9. 与现有文档的关系

| 文档 | 用途 |
| --- | --- |
| `README.md` | 功能总览 + 两种数据模式 + 部署 |
| `docs/GitHub私有仓库令牌配置.md` | **手动路线**：Fine-grained PAT 的逐项配置、排错、接口清单 |
| 本文档 | **一键路线**：Device Flow + 自动建仓的实施教程与安全权衡 |

用户视角只有一句话的差别：**想省事点「一键创建」，想最小权限就填自己的令牌。**
