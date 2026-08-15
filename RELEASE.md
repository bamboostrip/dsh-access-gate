# 发布流程（Release）

发布 npm 包有两条路：**GitHub Actions 自动发布（推荐）** 和 **本机手动发布**。
两者都要求先在 npmjs.com 完成一次配置。

## 一、npmjs.com 一次性配置（二选一）

### 方式 A：OIDC 可信发布（推荐，无需任何 token）

GitHub Actions 发布时用短期 OIDC 身份向 npm 认证，无长期密钥、不受 2FA 影响。

1. 打开包页面：`https://www.npmjs.com/package/dsh-access-gate`
2. 点击 **"Publishing"** 标签
3. 添加可信发布者：

   | 字段 | 值 |
   |---|---|
   | Organization | `bamboostrip`（GitHub 用户名） |
   | Repository | `dsh-access-gate` |
   | Workflow name | `publish.yml` |
   | Environment | 留空（默认） |

4. 保存。之后推送 `v*` 标签即自动发布。

### 方式 B：Granular Access Token（备选）

1. `https://www.npmjs.com/settings/bamboostrip/tokens` → **Generate New Token** →
   Granular Access Token，权限 **Read and write**，勾选 **Enable bypass 2FA**
2. 复制生成的 `npm_...` token，存入 GitHub Secrets（仓库 → Settings → Secrets
   and variables → Actions）：
   - Name: `NPM_TOKEN`，Value: 粘贴 token
3. 打开 `.github/workflows/publish.yml`，取消 `Publish to npm` 步骤里
   `NODE_AUTH_TOKEN` 两行注释

## 二、发布一个新版本

```sh
# 1) 更新版本号（自动 bump + 打 v 标签）
npm version patch    # 0.4.0 -> 0.4.1（小修复）
npm version minor    # 0.4.0 -> 0.5.0（新功能）
npm version major    # 0.4.0 -> 1.0.0（破坏性变更）

# 2) 推送（含标签）→ GitHub Actions 自动构建 + 发布
git push origin main --tags
```

Workflow 校验：git 标签必须与 `package.json` 的 version 一致（`npm version`
自动保证）；发布产物带 provenance（SLSA 溯源）。workflow 内置 `npm install -g
npm@latest`（OIDC trusted publishing 要求 npm ≥ 11.5.1，Node 22 捆绑的
npm 10 不支持 —— 会 404 且无有效提示）。

## 三、本机手动发布（备用）

```sh
npm run build
npm run check:package
npm publish --otp=XXXXXX   # 需要 2FA 验证码（TOTP 或 passkey 视账号配置）
```

## 四、发布后验证

```sh
npm view dsh-access-gate version        # 应显示新版本
dsh plugin --profile web add dsh-access-gate   # 真实安装验证
```

注意：npm 官方 registry 立即可见，但国内镜像（npmmirror）同步可能有几分钟到
数小时延迟；装不上可先用 `github:bamboostrip/dsh-access-gate`。
