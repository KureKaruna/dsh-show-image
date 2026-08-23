# dsh-show-image

把工作区中的图片直接发送到 DSH WebUI 对话流，让用户在聊天记录里看到图片画廊和灯箱预览。

![dsh-show-image demo](https://raw.githubusercontent.com/KureKaruna/dsh-show-image/demo/demo.png)

> 展示图保存在 `demo` 分支，不包含在 `main` 分支中。

## 功能

- 注册模型工具 `show_image`。
- 支持 PNG、JPEG、WebP、GIF。
- 从 DSH 文件系统服务读取工作区文件，并保存到持久化附件库。
- 在用户的 WebUI 会话中渲染图片画廊，可打开灯箱预览。
- 支持可选 caption。
- 图片字节不会作为图片内容发送到模型上下文。
- 使用结构化 `ImageBlock` 作为会话附件引用，确保浏览器可以通过会话附件接口读取图片。
- 兼容顶层原生工具调用和 `run_code` 子派发。

## 安装

将仓库安装到 DSH profile：

```sh
dsh plugin --profile test add https://github.com/KureKaruna/dsh-show-image.git
```

也可以使用本地路径安装：

```sh
dsh plugin --profile test add C:/path/to/dsh-show-image
```

安装后重启 DSH WebUI，使宿主端和浏览器端插件一起加载。插件通过 `cordis.patch.yml` 自动加入 profile bundle。

## 使用

在对话中提出类似请求：

> 把工作区里的 `render.png` 发给我看看。

模型会调用：

```json
{
  "file_path": "C:/path/to/render.png",
  "caption": "本次渲染结果"
}
```

图片随后会作为独立的聊天画廊节点显示在 WebUI 中。`file_path` 必须指向当前 DSH 文件系统可访问的图片文件。

## 工作原理

### 宿主端

`index.js` 注册 `show_image` 工具：

1. 校验扩展名和附件服务支持的图片类型。
2. 通过 DSH 文件系统服务解析路径并读取字节。
3. 调用 `attachments.saveImage()` 保存图片，得到 `ImageAttachmentRef`。
4. 返回供模型使用的文本摘要和规范化附件信息。
5. 对顶层调用，将用户侧载荷写入 `presentationMeta`。
6. 对 `run_code` 子派发，通过 `tools/code-dispatch-log` 只修改持久化日志副本，附加结构化 `ImageBlock` 和客户端标记。

插件不创建自定义顶层 session event。这样可以保持会话日志兼容 DSH 的已知事件类型和回放逻辑。

### 浏览器端

`client.js` 注册一个 `ConversationNodeDefinition`：

- 匹配带有 `dsh-show-image` meta 的 `tool/result`。
- 匹配带有图片载荷标记的 `tool/code-dispatch`。
- 使用 `renderMessageImages` 复用 WebUI 内置图片画廊和灯箱。
- 以事件序号作为节点身份，支持会话历史回放。

## 文件结构

- `index.js`：宿主端 `show_image` 工具和持久化日志增强。
- `client.js`：浏览器端对话节点和图片渲染器。
- `cordis.patch.yml`：将插件加入 DSH bundle 的 Cordis patch。
- `package.json`：插件入口、客户端入口和 DSH bundle 声明。
- `index.d.ts`、`client.d.ts`：最小类型声明。
- `demo.png`：仅位于 `demo` 分支的展示图片。

## 开发验证

在插件目录执行：

```sh
node --check index.js
node --check client.js
```

如果修改了宿主端代码，需要重启 DSH WebUI；客户端 bundle 的变更则需要重新构建或通过正在运行的客户端插件开发 watcher 加载。

## 限制

- 图片必须是 DSH 文件系统服务可读取的本地工作区路径。
- 图片仍受当前部署的附件大小、尺寸和像素限制约束。
- 已经写入会话的旧事件如果没有结构化 `ImageBlock`，其历史图片可能无法通过附件授权接口重新读取；修复后的新发送会携带完整引用。

## License

本项目采用 [MIT License](LICENSE)。
