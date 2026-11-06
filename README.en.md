# dsh-keine

English | [简体中文](README.md)

> "I devour history." — the part I ate, **only I remember it**.
>
> — Keine Kamishirasawa

A teacher for your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) transcript:
**recall a whole turn** and **edit-and-resend**, images included.

Named after Keine Kamishirasawa from *Touhou Project*. A terakoya teacher who shows her hakutaku
form under the full moon, with the power to **devour history** and **create history** — which is
exactly the pair of verbs a chat log needs.

---

## Why her

A DSH session log is append-only: a wrong prompt, a bad answer, an image paired with the wrong
text — all of it stays in the model context and poisons every later turn. The only official tool is
whole-range compaction (`/compact`); there is no per-message operation.

The community has tried, but each attempt stops one step short:

| Approach | What breaks |
| --- | --- |
| Per-message delete | Delete only — you still have to retype the message |
| Branch-based resend | The resend hard-codes `content` to plain text, so **images are dropped** |
| Recall | Shadows "text rows"; the image bubble stays behind |

Keine finishes the job: **an image is not a side channel — it lives inside the message event**, so
eating the message eats the pictures, and resending the message carries them along untouched.

## What she can do

| Action | Effect |
| --- | --- |
| ↩ **Devour history** (recall turn) | Shadows the message through the end of the session: your prompt, the reply, the tool calls and the process rows all leave the context together |
| ✎ **Create history** (edit & resend) | Shadows the same range, then starts a new turn with your edited text plus **the original images** |
| 🖼 **Edit images** | Each image in the dialog gets a thumbnail with `✕`; add more with `＋` or by **pasting** |

Removed images are simply not re-sent. New ones go through the official attachment admission path
(normalization, batch limits and content dedup are all its job).

## Install

```sh
# from GitHub
dsh plugin --profile web add github:SaigyoujYuyuko/dsh-keine

# local development (link: code changes apply after a restart)
dsh plugin --profile web add link:/path/to/dsh-keine
```

Then **fully restart dsh** and hard-refresh the page. The host plugin tree is read at startup only,
and the client bundle is cached by file mtime, so a page refresh alone may not be enough.

## Usage

1. Hover one of your own messages — `✎` and `↩` appear in the control strip under the bubble;
2. `↩` after confirmation removes that turn and everything after it;
3. `✎` opens the dialog: edit the text, remove images, paste images, then "Save & resend".

The buttons only show on hover — unobtrusive, like Keine when she is just a gentle terakoya
teacher.

## How she eats it

A message with images is **one** `user/message` event in the log:

```json
[{ "type": "image", "attachment": { "attachmentId": "sha256:…", "mediaType": "image/png",
   "width": 764, "height": 1024, "bytes": 385459, "name": "image.png" } },
 { "type": "text", "text": "what is in this picture" }]
```

So:

- **Devouring** appends a `user/message` carrier carrying the official
  `surfaceOp: { op: 'replace', startSeq, endSeq }`, which shadows the range from the surface.
  `deriveMessages()` stops projecting it, so the model never sees it again. Same contract as
  `/compact` — not a hack.
- **Creating** then hands `agent.followup()` the original image blocks plus the new text; the agent
  appends them as a fresh `user/message` at the start of the next turn.
- **No re-upload**: `attachmentId` is a content-addressed durable object; referencing it is enough.

The carrier records `sourceEventSeqs: [shadowed seqs]` — the eaten history stays accounted for,
which is the literal meaning of "only she remembers".

## Honest limits

- **Not erasure.** Not a single byte is deleted, and the image objects stay in `~/.dsh/attachments`
  (the official policy is no GC). Deleted for the model, not for the disk. Do not use it as a
  privacy tool.
- **Recall goes from that message to the end of the session**, not just that one turn.
- **Only works on a session that is open** — the host cannot reach a cold session's live handle.
- **No un-recall.** Under append-only semantics the only way back is rebuilding the session from the
  raw log.
- If `agent.followup()` throws after the shadow has landed, the shadow stays. Every plugin in this
  space pays that cost.

## Compatibility

- Verified against **DSH 0.2.0-rc.2** (web profile, Windows).
- No DSH source is modified and no private event types are written; the host half resolves
  `sessions` / `sessionQuery` / `agents` / `webServer` / `attachments` through the cordis context.
- The client locates message rows only through the official `data-chat-flow-*` anchors and the
  `useChat` snapshot — no React fiber introspection, no CSS-module class hashing.

## Name & thanks

- **Keine Kamishirasawa** — terakoya teacher, devourer of history. The name came from the user, and
  it fits far better than the author's own idea.
- Pitfall reference: the zero-width-space carrier from
  [`dsh-delete-turn`](https://github.com/DDDMUC/dsh-delete-turn) (an empty content list is refused
  by strict providers with `user message must contain content`).
- And Yuyuko Saigyouji — after all, eaten history ends up with the dead.

## License

MIT
