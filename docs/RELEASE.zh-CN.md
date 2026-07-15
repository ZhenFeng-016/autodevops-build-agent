# BuildAgent 中文发布手册

本文是 `autodevops-build-agent` 的中文操作手册，覆盖从功能分支到 npm `next` 验证、AutoDevOps 平台服务器验证，再到提升为 `latest` 的完整流程。

> `Agent next` 和 `Install Agent` 只会安装 npm 上已经发布的版本，不会发布本地源码。必须先完成 GitHub PR、版本 PR 和 npm 发布。

## 发布对象与版本规则

仓库包含四个公开包：

- `@zhenfengxx/contracts`
- `@zhenfengxx/agent-sdk`
- `@zhenfengxx/repo-inspector`
- `@zhenfengxx/build-agent`

这四个包属于 Changesets 固定版本组，会保持相同版本。即使改动主要位于 BuildAgent，版本 PR 也会同步更新四个包。

npm 标签的含义：

- `next`：候选版本，先在真实测试服务器验证。
- `latest`：已完成验证的正式版本，平台的普通 `Install Agent` 默认安装该版本。

## 发布前检查

发布前确认：

1. 功能改动包含 Changeset。
2. 本地工作树干净，分支已经推送。
3. 已运行与改动相匹配的本地验证；完整验证命令为：

   ```bash
   npm ci
   npm run ci
   ```

4. GitHub `npm` Environment 已限制为受保护的 `main` 分支。
5. 四个 npm 包均已配置 `publish-npm-packages.yml` Trusted Publisher。
6. GitHub `npm` Environment 中存在仅用于 `npm dist-tag add` 的细粒度 `NPM_PROMOTE_TOKEN`。

任何密码、2FA、恢复码或 Token 值都不得写入源码、命令参数、PR、Actions 日志或普通仓库 Secret。`NPM_PROMOTE_TOKEN` 只允许存放在受保护的 `npm` Environment 中。

## 第一步：创建并合并功能 PR

在 GitHub 打开当前功能分支到 `main` 的 Pull Request，例如：

```text
https://github.com/ZhenFeng-016/autodevops-build-agent/compare/main...<branch>?expand=1
```

PR 描述至少写明：

- 本次修改内容。
- 影响的 Agent 协议、执行器或安装路径。
- 已运行的验证命令。
- 是否包含 Changeset。

PR 创建后会触发 `CI / verify`。只有在以下条件都满足后才能合并：

- `CI / verify` 为绿色。
- 分支与 `main` 保持最新。
- Review 对话已解决。
- Changeset 与实际发布影响一致。

推荐使用仓库允许的线性合并方式，例如 `Squash and merge`。

## 第二步：合并 Changesets 版本 PR

功能 PR 合并到 `main` 后，`Version packages` 工作流会自动创建或更新版本 PR：

```text
chore(release): version packages
```

在版本 PR 中检查：

1. 四个公开包的版本一致。
2. 版本增量符合 Changeset，例如 patch 从 `1.2.0` 升到 `1.2.1`。
3. `package-lock.json` 已同步。
4. Changelog 包含本次发布内容。
5. `CI / verify` 为绿色。

确认后合并版本 PR。版本 PR 未合并前，不要运行 npm 发布工作流。

## 第三步：发布候选版本到 `next`

进入 GitHub：

```text
Actions -> Publish npm packages -> Run workflow
```

选择：

```text
Branch: main
```

该工作流会执行：

1. 干净环境安装依赖。
2. 完整 `npm run ci`。
3. 使用 npm Trusted Publishing/OIDC 发布四个已经完成版本更新的包。
4. 将候选版本写入 npm `next` 标签。

工作流成功后验证标签：

```bash
npm view @zhenfengxx/build-agent dist-tags --json --registry=https://registry.npmjs.org
npm run release:verify -- <version>
```

预期状态示例：

```json
{
  "latest": "1.2.0",
  "next": "1.2.1"
}
```

如果 `next` 仍指向旧版本，先检查发布工作流，不要直接操作服务器。

## 第四步：在平台安装 `Agent next`

刷新 AutoDevOps 平台的服务器列表，确认 BuildAgent 一栏显示新的 `next` 版本。

在测试服务器行点击：

```text
Agent next
```

该按钮会：

1. 从 npm 获取 `next` 标签。
2. 将标签解析成精确版本。
3. 在 build 角色服务器上安装该精确版本。
4. 重启 PM2 中的 BuildAgent。
5. 等待新 Agent 心跳。
6. 校验目标版本、实际版本和协议版本。
7. 安装或验证失败时回滚到之前的版本和 PM2 配置。

Provisioning Job 必须满足：

- Status：`succeeded`
- Target Version：候选版本
- Actual Version：候选版本
- Verification：通过
- BuildAgent：`online`
- Last Heartbeat：持续更新

`Agent next` 仅用于 build 角色服务器。生产运行机本身不需要安装 BuildAgent，远程生产操作由 build 服务器上的 Agent 通过 SSH 执行。

## 第五步：执行真实 Oak 项目验收

不要只以 Agent 心跳作为发布成功标准。至少选择一个包含私有 Oak Git 依赖的项目执行真实 `Sync + Install`。

重点检查：

- 主仓库能够使用平台 Git Key 拉取。
- `package.json` 中的 `git+ssh` Oak 依赖能够安装。
- 测试机本地安装成功。
- 生产机远程安装成功。
- 瞬时 Git/SSH 断连会出现有限次数的重试日志。
- `Permission denied`、仓库不存在等永久错误会立即失败，不会重复重试。

候选版本未通过真实项目验收时，保持 `latest` 不变，修复后发布新的 patch 到 `next`。

## 第六步：将候选版本提升为 `latest`

候选版本通过测试服务器和真实 Oak 项目验收后，进入 GitHub：

```text
Actions -> Promote npm packages to latest -> Run workflow
```

填写：

```text
Branch: main
version: <已经发布并验证的 next 版本>
```

工作流会先确认：

- 四个包的 `next` 都指向输入版本。
- 输入版本确实已经发布。
- `NPM_PROMOTE_TOKEN` 可以执行受限的 `npm dist-tag add`。

成功后再次验证：

```bash
npm view @zhenfengxx/build-agent dist-tags --json --registry=https://registry.npmjs.org
npm run release:verify -- <version>
```

预期状态：

```json
{
  "latest": "<version>",
  "next": "<version>"
}
```

## 第七步：正式服务器更新

平台服务器列表刷新后，普通按钮：

```text
Install Agent
```

会安装 npm `latest` 指向的精确版本。对其他 build 角色服务器逐台更新，并确认每台服务器的心跳版本、协议版本和在线状态。

已通过 `Agent next` 安装同一版本的测试服务器无需重复安装。

## 常见问题与停止条件

### 没有自动生成版本 PR

- 检查功能 PR 是否已经合并到 `main`。
- 检查提交中是否包含 Changeset。
- 查看 `Version packages` Actions 日志。
- 不要手工直接修改 npm 标签绕过版本 PR。

### `Publish npm packages` 失败

- 检查四个包的 Trusted Publisher 配置。
- 检查工作流是否从 `main` 运行。
- 检查 GitHub `npm` Environment 的分支限制。
- 不要为了绕过 OIDC 临时添加宽权限 npm Token。

### 只有部分包发布成功

四个包是固定版本组。任一包缺失时都不得提升 `latest`。修复 Publisher 配置后，重新运行幂等发布流程，并重新验证全部四个包。

### 平台看不到新的 `next`

- 用 `npm view` 确认 npmjs.org 上的真实标签。
- 刷新服务器页面。
- 检查平台访问 `https://registry.npmjs.org` 是否正常。
- npm 标签未更新前不要点击 `Agent next`。

### `Agent next` 安装失败

- 查看 Provisioning Job 的 stdout、stderr、Target Version 和 Actual Version。
- 确认自动回滚结果。
- 确认旧 Agent 恢复在线后再继续排查。
- 不要在验证失败后提升 `latest`。

### 提升 `latest` 失败

- 确认输入版本与四个包的 `next` 完全一致。
- 确认 `NPM_PROMOTE_TOKEN` 位于受保护的 `npm` Environment。
- 确认 Token 仅对四个公开包具有所需的 dist-tag 权限。
- 保持现有 `latest` 不变，修复后重新运行提升工作流。

