# GitHub 私有仓库：令牌与权限配置

> 关联：`README.md` 的「把 GitHub 私有仓库当「数据库」（跨设备同步）」
> 适用：用**自己的私有仓库**存放持仓数据，页面通过 GitHub Contents API 读写其中一个文件
> 代码位置：`web/src/services/github-api.js`（接口与错误文案）、`github-sync.js`（配置项与同步策略）

---

## 1. 先分清两个仓库

| 仓库 | 用途 | 可见性 |
| --- | --- | --- |
| **代码仓库**（如 `stock-advisor`） | 存放本项目源码，GitHub Pages 从这里构建 | 免费账号需 **Public** |
| **数据仓库**（如 `my-collector-data`） | 只存一个数据文件，当作数据库 | 必须 **Private** |

两者互不影响：代码公开、数据私有是正常组合。数据仓库一旦被设为公开，页面的同步面板会给出警告并禁用「上传 / 双向同步」按钮。

---

## 2. 生成 Fine-grained 令牌（核心步骤）

### 2.1 入口

<https://github.com/settings/personal-access-tokens/new>

（也可以从 Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token 进入。）

### 2.2 逐项填写

| 配置项 | 填什么 | 说明 |
| --- | --- | --- |
| **Token name** | 随意，如 `stock-advisor-data` | 只是为了以后能认出用途 |
| **Expiration** | 90 天（或自定义） | 到期后页面会报 401，重新生成并更新配置即可 |
| **Repository access** | **Only select repositories** | 不要选 All repositories |
| ↳ 仓库列表 | 只勾 **`my-collector-data`**（你的数据仓库） | 令牌若在仓库创建之前生成，这里不会出现它，需要重新生成 |
| **Permissions → Repository permissions → Contents** | **Read and write** | 读取 + 创建/更新数据文件，必须项 |
| **Permissions → Repository permissions → Metadata** | `Read-only`（自动附带） | 勾了任意仓库权限后 GitHub 自动添加，删不掉也不用管 |
| 其他 Repository permissions | 全部 **No access** | Actions / Administration / Workflows 等都不需要 |
| **Account permissions** | 全部 **No access** | 本方案不涉及账号级接口 |

点 **Generate token**，复制 `github_pat_...`。

> 令牌只显示一次。请立刻存进密码管理器，并与「加密口令」分开保存。

### 2.3 关于只读权限

`Contents: Read only` 也能通过页面的「测试连接」（读取仓库元信息与文件），但首次「上传到云端」会返回 **403**。想省事就直接给 **Read and write**。

### 2.4 不要用 classic token

Classic token 没有仓库级细粒度，只能给整个 `repo` 全权限（该账号下所有私有仓库可读写）。泄露面远大于 Fine-grained，本方案不需要它。

---

## 3. 初始化数据仓库

**空仓库没有 `main` 分支**，首次写文件时 GitHub 会拒绝（页面报 `422`）。先在网页上初始化一次：

- 新建仓库时勾选 **Add a README file**，或
- 仓库首页 → **Add file → Create new file**，随便提交一个文件

不需要建目录：文件路径里的子目录（如 `data/holdings.json`）会由 GitHub 自动创建。

---

## 4. 在页面里填写配置

打开站点 → 顶部「**🗄 数据**」→ 选「**☁️ GitHub 私有仓库**」：

| 字段 | 示例 | 备注 |
| --- | --- | --- |
| 用户名 / 组织 | `salenju` | 只填名字，**不要**填 `https://github.com/salenju` 或 `salenju/repo` |
| 私有仓库名 | `my-collector-data` | 只填仓库名，不要带 `.git` 或完整 URL |
| 文件路径 | `stock-advisor-data.json`（默认） | 可改成 `data/holdings.json` 等；留空会用默认值 |
| 分支 | `main` | 仓库默认分支是 `master` 时改成 `master`；「测试连接」会回显实际默认分支 |
| 访问令牌 | `github_pat_...` | 只存本机浏览器，不会写进仓库 |
| 加密口令 | 自定义一段 | 可选但强烈建议；**没有找回途径** |
| 自动上传 | 勾选 | 持仓/交易数据改动后**停止操作 3 分钟**再合并推送一次；行情刷新只写本机，不产生提交 |

操作顺序：**保存配置 → 测试连接 → 上传到云端**（首次创建文件）。

「测试连接」成功时应显示：

```
连接成功：salenju/my-collector-data（私有）· 默认分支 main · 云端还没有数据文件（首次同步会创建）
```

若仓库是公开的，会改为警告文案，「上传 / 双向同步」按钮保持禁用。

---

## 5. 第二台设备（手机 / 另一台电脑）

1. 打开同一页面 → 「🗄 数据」→ 选「☁️ GitHub 私有仓库」
2. 填 **相同的 owner / repo / path / branch / token / 口令**
3. 点「测试连接」→ 点「**从云端拉取**」

> 新设备上**不要**点「上传到云端」：会用本机空库覆盖云端。先拉取，之后正常改动再自动推送。

注意：配置保存在**当前域名**的 localStorage 里。本地 `http://localhost:5173` 与线上 Pages 站点是两套独立配置，需要各自填写。

### 同步时机（重要）

| 动作 | 行为 |
| --- | --- |
| 本机新增/修改/删除持仓、交易、导入、回滚 | **停止操作 3 分钟**后自动推送一次（可在配置面板关闭） |
| 行情刷新 / 只看不改 | 只写本机 IndexedDB，不产生云端提交 |
| 打开或刷新页面 | **不会自动拉取**，只读本机数据 |
| 云端被其他设备更新 | 页面每分钟检查一次，顶部出现「云端有来自其他设备的更新」，点「立即同步」先拉取合并再写回；点「稍后」本次不再提醒 |
| 关闭页面 / 切到后台 | 尽力补推待上传的改动（不保证送达，重要改动请手动点「上传到云端」） |

建议：换设备后先点一次「**双向同步**」再操作，避免两台设备同时修改后互相覆盖。

---

## 6. 排错：按 HTTP 状态码定位

### 6.1 自查命令

把 `<TOKEN>` 换成 `github_pat_...`（不要带 `Bearer` 前缀）：

```bash
# ① 令牌属于哪个账号？应为仓库所有者
curl -s -H "Authorization: Bearer <TOKEN>" https://api.github.com/user | grep '"login"'

# ② 令牌能看见这个仓库吗？（核心一步）
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/salenju/my-collector-data

# ③ 能看见后，再看数据文件（404 属正常：还没上传过）
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <TOKEN>" \
  https://api.github.com/repos/salenju/my-collector-data/contents/stock-advisor-data.json
```

### 6.2 错误对照表

页面文案来自 `web/src/services/github-api.js` 的 `friendlyError()`。

| 页面提示 | 实际含义 | 处理 |
| --- | --- | --- |
| `401 访问令牌无效或已过期` | 令牌错误、已过期、已被撤销；或粘贴时多了 `Bearer ` / 换行 | 重新生成并只粘贴 `github_pat_` 开头的那串 |
| `403 没有权限：请确认令牌具备该仓库的 Contents 读写权限` | 只给了 `Read`；或组织要求 SSO 授权 | 改成 `Read and write`；组织仓库需在令牌页 Authorize |
| `403 … GitHub API 触发了限流（每小时 5000 次）` | 调用过于频繁 | 等响应头里的重置时间后再试 |
| **`404 仓库或文件不存在：请检查用户名、仓库名、分支名和路径…`** | **Fine-grained 令牌看不到该仓库时，GitHub 统一返回 404**（不暴露私有仓库是否存在）。也可能是 owner/repo 填错、分支不存在 | 先跑 6.1 的 ②：返回 404 就是令牌未授权该仓库（重新确认 Repository access 勾选）；返回 200 才是路径/分支/字段问题 |
| `409 远程文件已被其他设备改动` | 远端 `sha` 变了 | 先「从云端拉取」合并，再上传 |
| `422 请求被 GitHub 拒绝` | 空仓库没有 `main` 分支；或提交信息为空 / `sha` 不匹配 | 按第 3 节初始化仓库；重试一次 |
| `路径 … 是一个目录` / `不是文件` | 文件路径指到了目录或其他类型 | 改成具体文件路径 |
| 面板提示「仓库是公开的」且按钮禁用 | 设计如此，防误传 | 仓库 Settings → 改为 Private |

> 牢记：对 Fine-grained 令牌而言，**404 ≈ 没权限**，不要把提示里的“不存在”当成唯一解释。

---

## 7. 令牌与口令的安全边界

| | 访问令牌 | 加密口令 |
| --- | --- | --- |
| 作用 | 让页面能读写那个私有仓库 | 在本机加密后才上传 |
| 存在哪 | 本机浏览器 localStorage（`stock-advisor:github-config`） | 同一处，**不会**发给 GitHub |
| 泄露后果 | 别人能改/删仓库里的文件 | 只有同时拿到密文才可能解开 |
| 补救 | 去 GitHub 撤销令牌，生成新的填回页面 | 换口令 → 重新上传覆盖云端 |
| 找回 | 可随时重新生成 | **无法找回**，忘记只能重新上传 |

建议：

- 令牌与口令都放进密码管理器，分别保存
- 不要在公用电脑 / 临时浏览器里填写
- 令牌设 90 天过期，到期后页面报 401，按第 2 节重新生成并更新配置
- 仓库被误设为公开：立刻改回 Private；若同时填了口令，密文本身仍不可读

---

## 8. 附：页面实际调用的接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /repos/{owner}/{repo}` | 测试连接：读仓库元信息（是否私有、默认分支、push 权限） |
| `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` | 拉取数据文件（文件不存在返回 404，客户端视为“首次同步”） |
| `PUT /repos/{owner}/{repo}/contents/{path}` | 创建/更新数据文件，必须带远端 `sha` 才能覆盖（乐观锁） |
| `DELETE /repos/{owner}/{repo}/contents/{path}` | 删除数据文件（清理用） |

请求头固定带 `Accept: application/vnd.github+json`、`Authorization: Bearer <token>`、`X-GitHub-Api-Version: 2022-11-28`。
