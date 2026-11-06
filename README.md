# dsh-keine

简体中文 | [English](README.en.md)

> 「历史を喰う」——被我吃掉的那一段，**只有我还记得**。
>
> —— 上白泽慧音

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的对话记录请来了一位老师：
**撤回整轮**和**改字重发**，连图片一起。

名字取自《东方 Project》的上白泽慧音。寺子屋的老师，满月之下现出白泽形态，能力是
**吞食历史**与**创造历史**——你会发现这正好是聊天记录需要的两件事。

---

## 为什么需要她

DSH 的会话日志是 append-only 的：说错话、发错提示词、图片配错文字，这些内容会一直留在
模型上下文里，污染后面每一轮。官方只给了「压缩」（`/compact`）这种整段摘要，没有单条消息
级别的操作。

社区里也不是没人做过，但都差一口气：

| 插件 | 差在哪 |
| --- | --- |
| 单条删除类 | 只能删，改完还得重新打字 |
| 分支重发类 | 重发时把 `content` 写死成纯文本，**图片直接丢** |
| 撤回类 | 遮蔽的是"文本行"，图片气泡留在原地 |

慧音把这件事做完整：**图片不是特殊通道，它就在消息事件里**，所以吞掉消息 = 吞掉图片，
重发消息 = 图片原样跟着走。

## 她能做什么

| 操作 | 效果 |
| --- | --- |
| ↩ **吞食历史**（撤回整轮） | 从这条消息到会话末尾整段遮蔽：你的提问、她的回复、工具调用、过程行一起离开上下文 |
| ✎ **创造历史**（编辑重发） | 遮蔽同样的区间，然后用你改过的文字 + **原来的图片**开一个新的回合 |
| 🖼 **改图** | 编辑弹窗里每张图带缩略图，右上角 `✕` 移除；`＋` 或直接**粘贴**加新图 |

移除的图片不再随新消息发出去；新加的图走官方附件入库（归一化、限额、内容去重都由它负责）。

## 安装

```sh
# 从 GitHub 装
dsh plugin --profile web add github:SaigyoujYuyuko/dsh-keine

# 或者本地开发（link，改完代码重启即生效）
dsh plugin --profile web add link:/path/to/dsh-keine
```

装完**完全重启 dsh**，然后硬刷新页面。宿主半边只在启动时读取插件树；客户端 bundle 按文件
mtime 缓存，只刷新页面不一定拿得到新的。

## 用法

1. 鼠标悬停你自己发的消息，气泡下方那条控制条里会多出 `✎` 和 `↩`；
2. `↩` 确认后，这一轮连同它之后的内容一起消失；
3. `✎` 打开弹窗：改字、删图、粘图，然后「保存并重发」。

按钮只在悬停时出现——平时不打扰你，就像慧音平时只是个温柔的寺子屋老师。

## 她是怎么吞的

一条带图的消息，在日志里就是**一个** `user/message` 事件：

```json
[{ "type": "image", "attachment": { "attachmentId": "sha256:…", "mediaType": "image/png",
   "width": 764, "height": 1024, "bytes": 385459, "name": "image.png" } },
 { "type": "text", "text": "这张图里是什么" }]
```

所以：

- **吞食历史** = 追加一条 `user/message` 载体，带官方的
  `surfaceOp: { op: 'replace', startSeq, endSeq }`，把区间从 surface 上覆盖掉。
  `deriveMessages()` 之后不再投影这段内容，模型下一轮就看不见了。
  和 `/compact` 用的是同一套契约，不是野路子。
- **创造历史** = 遮蔽之后，把「原来的图片块 + 新文字」交给 `agent.followup()`，
  由 agent 在下一轮开头 append 成新的 `user/message`。
- **图片不重新上传**：`attachmentId` 是内容寻址的持久对象，原样引用即可。

载体里还记着 `sourceEventSeqs: [被遮蔽的 seq]`——**吃掉的历史有账可查**，这也是"她记得"
的字面意思。

## 老实说，边界在哪

- **不是抹除**。原始事件一个字节没删，图片对象也还在 `~/.dsh/attachments`（官方明确不做 GC）。
  对模型是删了，对磁盘是没删。别拿它当隐私工具。
- **「撤回」是从这条到末尾**，不是只删这一轮。
- **只能在已打开的会话上操作**——宿主拿不到冷会话的 live session。
- **没有「反撤回」**。append-only 语义下，想还原只能从原始日志重建会话。
- 编辑时若 `agent.followup()` 抛错，遮蔽已经发生。这是所有同类插件的共同代价。

## 兼容性

- 实测 **DSH 0.2.0-rc.2**（web profile，Windows）。
- 不修改 DSH 源码，不写私有事件类型；宿主半区只通过 cordis 上下文解析
  `sessions` / `sessionQuery` / `agents` / `webServer` / `attachments`。
- 客户端只用官方 `data-chat-flow-*` 锚点和 `useChat` 快照定位消息行，不碰 React fiber、
  不哈希 CSS 类名。

## 名字与致谢

- **上白泽慧音** —— 寺子屋老师，历史を喰う人。这个名字是用户想出来的，比作者自己想的贴切。
- 踩坑参考：[`dsh-delete-turn`](https://github.com/DDDMUC/dsh-delete-turn) 的零宽空格载体
  （空 content 会被严格 provider 以 `user message must contain content` 拒掉）。
- 以及西行寺幽幽子——毕竟被吃掉的历史，最后都归亡灵管。

## License

MIT
