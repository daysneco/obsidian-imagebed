# Obsidian Imagebed

一个 Obsidian 插件：将粘贴到编辑器中的图片自动上传到 GitHub 仓库，并插入 `raw.githubusercontent.com` 直链。

## 功能特性

- 监听编辑器粘贴事件，自动识别剪贴板中的图片文件
- 上传图片到 GitHub 仓库指定分支
- 自动插入 Markdown 图片链接：`![](https://raw.githubusercontent.com/...)`
- 自动清洗文件名，按年月分目录保存：`images/YYYY/MM/...`
- 内置重试机制（最多 3 次）和错误提示
- 支持在设置页一键测试连接（可用性和写权限）

## 环境要求

- Obsidian `>= 1.4.0`
- 一个可写的 GitHub 仓库
- 一个具备仓库内容写权限的 Token（推荐 Fine-grained PAT，需开启 `Contents: Read and write`）

## 安装方式

### 手动安装（本地插件目录）

1. 打开你的 Obsidian 仓库目录：
   `.obsidian/plugins/obsidian-imagebed/`
2. 确保目录中至少包含：
   - `manifest.json`
   - `main.js`
3. 在 Obsidian 中打开：
   `设置 -> 第三方插件 -> 已安装插件`
4. 启用 `Obsidian Imagebed`

## 配置说明

在插件设置中填写以下参数：

- `GitHub Token`：用于调用 GitHub API 上传文件
- `Repository`：目标仓库，格式 `owner/repo`
- `Branch`：目标分支，默认 `main`

点击 `Test Connection` 可验证：

- Token 是否有效
- 仓库是否可访问
- 分支是否存在且可写
- 当分支不存在时，会尝试基于默认分支自动创建

## 使用方法

1. 在 Obsidian 编辑器中粘贴图片（截图或复制图片）
2. 插件会自动上传图片到 GitHub
3. 上传成功后，编辑器中会插入 Markdown 图片链接

示例输出：

```md
![](https://raw.githubusercontent.com/owner/repo/main/images/2026/02/20260210103000123-pasted-image.png)
```

## 存储路径规则

图片默认上传路径格式：

`images/{year}/{month}/{timestamp}-{filename}.{ext}`

例如：

`images/2026/02/20260210153001234-my-screenshot.png`

## 常见问题

- `401`：Token 无效或已过期
- `403`：Token 权限不足（需要仓库内容写权限）
- `404`：仓库名错误，或 Token 无权访问该仓库
- 上传失败会自动重试 3 次，并在 Obsidian 中显示失败原因

## 隐私与安全

- Token 仅保存在本地 Obsidian 插件数据中
- 请勿将 Token 提交到公开仓库
- 建议使用最小权限 Token，并仅授予目标仓库权限

## License

MIT
