// dsh-keine — browser half.
//
// Two entries, both mounted from `conversation.input.overlay`:
//
//   * a per-session controller that decorates every USER message row with two
//     hover actions (✎ 编辑重发 / ↩ 撤回整轮);
//   * a confirmation panel that edits the text while keeping the original image
//     blocks, or states exactly what a recall removes.
//
// Row targeting uses only official anchors: the `data-chat-flow-*` attributes
// the chat publishes plus the official `useChat` snapshot (the same Map the chat
// renders from). No React fiber introspection, no CSS-module class names.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with window.__ModuleLoader__ and returns apply().
window.__ModuleLoader__.load({
  id: 'dsh-keine',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const { jsx, jsxs, Fragment } = jsxRuntime
    const { useCallback, useEffect, useRef, useState } = react

    const NS = 'dsh-keine'
    const ROUTE = '/api/plugins/keine'

    // --- copy -----------------------------------------------------------------

    const zh = {
      edit: '编辑重发',
      recall: '撤回整轮',
      editTitle: '编辑这条消息并重发',
      recallTitle: '撤回这条消息',
      keepImages: (n) => `${n} 张图片会原样保留`,
      dropImages: (n) => `${n} 张图片会一并从上下文移除`,
      hintEdit: '改完重发：这条消息之后的内容会被截断，新的回合从这里开始。',
      hintRecall: '这条消息及其之后的所有回合都会离开模型上下文，原始日志不改写。',
      confirmEdit: '保存并重发',
      confirmRecall: '撤回',
      cancel: '取消',
      busy: '这个会话正在回复中，等它结束再操作。',
      blank: '内容不能为空。',
      failed: '操作失败',
      removeImage: '移除这张图片',
      addImage: '添加图片（也可以直接粘贴）',
    }

    // Neutral tile shown when a stored thumbnail cannot be served.
    const BROKEN_THUMB =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="86" height="86"><rect width="86" height="86" rx="8" fill="#2a2a30"/><text x="43" y="48" font-family="sans-serif" font-size="11" fill="#8a8a92" text-anchor="middle">无预览</text></svg>',
      )

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    // --- styles ---------------------------------------------------------------

    const CSS = `
[data-keine-actions]{display:flex;gap:4px;opacity:0;pointer-events:none;transition:opacity .12s ease;z-index:6}
[data-chat-flow-key]:hover [data-keine-actions],[data-keine-actions]:focus-within{opacity:1;pointer-events:auto}
[data-keine-actions][data-keine-anchor="actions"]{position:static;display:inline-flex;align-items:center;gap:2px;margin-left:2px;opacity:1;pointer-events:auto}
[data-keine-actions][data-keine-anchor="stack"]{position:absolute;right:calc(100% + 8px);top:50%;transform:translateY(-50%)}
[data-keine-actions][data-keine-anchor="row"]{position:absolute;right:10px;top:8px}
[data-keine-actions] button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.24));border-radius:8px;background:var(--dsw-alias-bg-elevated,rgba(28,28,32,.86));color:var(--dsw-alias-label-secondary,#c9c9cf);font-size:13px;line-height:1;cursor:pointer;backdrop-filter:blur(6px);transition:background .12s ease,color .12s ease}
[data-keine-actions] button:hover{background:var(--dsw-alias-bg-hover,rgba(62,62,70,.95));color:var(--dsw-alias-label-primary,#fff)}
[data-keine-actions][data-keine-anchor="actions"] button{width:22px;height:22px;border:0;background:transparent;color:inherit;backdrop-filter:none;opacity:.75}
[data-keine-actions][data-keine-anchor="actions"] button:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.18));opacity:1}
[data-keine-backdrop]{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:2147483000}
[data-keine-dialog]{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 80px);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;background:var(--dsh-surface,#1c1c1f);color:var(--dsh-text,#ececee);border:1px solid var(--dsh-border,rgba(127,127,127,.3));box-shadow:0 18px 60px rgba(0,0,0,.45);font-size:13px}
[data-keine-dialog] h3{margin:0;font-size:14px;font-weight:600}
[data-keine-dialog] p{margin:0;opacity:.72;line-height:1.5}
[data-keine-dialog] textarea{width:100%;min-height:120px;max-height:40vh;resize:vertical;padding:10px;border-radius:8px;border:1px solid var(--dsh-border,rgba(127,127,127,.3));background:var(--dsh-input,rgba(0,0,0,.25));color:inherit;font:inherit;line-height:1.55;box-sizing:border-box}
[data-keine-gallery]{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
[data-keine-thumb]{position:relative;width:86px;display:flex;flex-direction:column;gap:4px}
[data-keine-thumb] img{width:86px;height:86px;object-fit:cover;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.24));background:rgba(0,0,0,.2)}
[data-keine-thumbplaceholder]{display:flex;align-items:center;justify-content:center;width:86px;height:86px;border-radius:8px;border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.3));font-size:22px;opacity:.6}
[data-keine-remove]{position:absolute;top:-6px;right:-6px;width:20px;height:20px;padding:0;border-radius:50%;border:0;background:rgba(20,20,24,.92);color:#fff;font-size:11px;line-height:1;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4)}
[data-keine-remove]:hover{background:#e5484d}
[data-keine-thumbmeta]{font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-keine-add]{display:flex;align-items:center;justify-content:center;width:86px;height:86px;border-radius:8px;border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.35));color:inherit;font-size:20px;opacity:.7;cursor:pointer}
[data-keine-add]:hover{opacity:1;background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
[data-keine-row]{display:flex;justify-content:flex-end;gap:8px;align-items:center}
[data-keine-error]{color:#ff7b72}
[data-keine-row] button{padding:5px 12px;border-radius:7px;border:1px solid var(--dsh-border,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;cursor:pointer}
[data-keine-row] button[data-primary]{background:#3b6cf6;border-color:#3b6cf6;color:#fff}
[data-keine-row] button:disabled{opacity:.55;cursor:default}
`

    // --- controller -----------------------------------------------------------

    function emptyView() {
      return { hidden: new Set(), hiddenTurns: new Set(), busy: false, loaded: false, dialog: null, error: null, pending: false }
    }

    class RecallController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.view = emptyView()
        this.listeners = new Set()
        this.inflight = null
      }

      getSnapshot = () => this.view

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      publish(patch) {
        this.view = Object.freeze({ ...this.view, ...patch })
        for (const listener of this.listeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-keine] subscriber threw:', error)
          }
        }
      }

      load(force) {
        if (this.inflight !== null) return this.inflight
        if (this.view.loaded && force !== true) return Promise.resolve()
        const url = `${ROUTE}/messages?sessionId=${encodeURIComponent(this.sessionId)}`
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            this.publish({
              hidden: new Set(Array.isArray(data.hidden) ? data.hidden : []),
              hiddenTurns: new Set(Array.isArray(data.hiddenTurns) ? data.hiddenTurns : []),
              busy: data.busy === true,
              loaded: true,
            })
          })
          .catch((error) => {
            console.warn('[dsh-keine] state load failed:', error && error.message)
            this.publish({ loaded: true })
          })
          .finally(() => {
            this.inflight = null
          })
        this.inflight = pending
        return pending
      }

      open(seq, mode) {
        this.publish({ dialog: { seq, mode, text: '', images: [], loading: true, busy: false, error: null } })
        const url = `${ROUTE}/message?sessionId=${encodeURIComponent(this.sessionId)}&seq=${seq}`
        fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            const images = (Array.isArray(data.images) ? data.images : []).map((image) => ({
              kind: 'kept',
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              width: image.width,
              height: image.height,
              name: image.name,
              thumb: `${ROUTE}/image?sessionId=${encodeURIComponent(this.sessionId)}&seq=${seq}&id=${encodeURIComponent(image.attachmentId)}`,
            }))
            this.publish({
              dialog: {
                seq,
                mode,
                text: typeof data.text === 'string' ? data.text : '',
                images,
                loading: false,
                busy: false,
                error: null,
              },
            })
          })
          .catch((error) => {
            this.publish({ dialog: null, error: String((error && error.message) || error) })
          })
      }

      close() {
        if (this.view.pending) return
        this.publish({ dialog: null, error: null })
      }

      setText(text) {
        if (this.view.dialog === null) return
        this.publish({ dialog: { ...this.view.dialog, text } })
      }

      removeImage(index) {
        const dialog = this.view.dialog
        if (dialog === null || !Array.isArray(dialog.images)) return
        const images = dialog.images.filter((_, position) => position !== index)
        this.publish({ dialog: { ...dialog, images } })
      }

      async addFiles(files) {
        const dialog = this.view.dialog
        if (dialog === null || files === null || files === undefined) return
        const list = Array.from(files).filter((file) => file && typeof file.type === 'string' && file.type.startsWith('image/'))
        if (list.length === 0) return
        const added = []
        for (const file of list) {
          try {
            const dataUrl = await readAsDataUrl(file)
            const comma = dataUrl.indexOf(',')
            if (comma < 0) continue
            added.push({
              kind: 'new',
              data: dataUrl.slice(comma + 1),
              mediaType: file.type,
              name: file.name || 'image',
              thumb: dataUrl,
            })
          } catch {
            // ignore an unreadable file and keep the rest
          }
        }
        if (added.length === 0) return
        const current = this.view.dialog
        if (current === null || !Array.isArray(current.images)) return
        this.publish({ dialog: { ...current, images: [...current.images, ...added], error: null } })
      }

      async submit() {
        const dialog = this.view.dialog
        if (dialog === null || this.view.pending) return
        if (dialog.mode === 'edit' && dialog.text.trim().length === 0) {
          this.publish({ dialog: { ...dialog, error: zh.blank } })
          return
        }
        this.publish({ pending: true, dialog: { ...dialog, error: null, busy: true } })
        const images = Array.isArray(dialog.images) ? dialog.images : []
        const body = dialog.mode === 'edit'
          ? {
              sessionId: this.sessionId,
              seq: dialog.seq,
              text: dialog.text,
              keep: images.filter((image) => image.kind === 'kept').map((image) => image.attachmentId),
              uploads: images
                .filter((image) => image.kind === 'new')
                .map((image) => ({ data: image.data, mediaType: image.mediaType, name: image.name })),
            }
          : { sessionId: this.sessionId, seq: dialog.seq }
        const endpoint = dialog.mode === 'edit' ? `${ROUTE}/edit` : `${ROUTE}/recall`
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            const message = data && data.error ? String(data.error) : `HTTP ${res.status}`
            this.publish({ pending: false, dialog: { ...dialog, busy: false, error: message } })
            return
          }
          const hidden = new Set(this.view.hidden)
          for (const seq of Array.isArray(data.shadowed) ? data.shadowed : []) hidden.add(seq)
          if (typeof data.carrierSeq === 'number') hidden.add(data.carrierSeq)
          const hiddenTurns = new Set(this.view.hiddenTurns)
          for (const turn of Array.isArray(data.hiddenTurns) ? data.hiddenTurns : []) hiddenTurns.add(turn)
          this.publish({ pending: false, dialog: null, hidden, hiddenTurns, loaded: true })
          if (dialog.mode === 'edit') window.setTimeout(() => this.load(true), 1200)
        } catch (error) {
          this.publish({ pending: false, dialog: { ...dialog, busy: false, error: String((error && error.message) || error) } })
        }
      }
    }

    // --- row decoration -------------------------------------------------------

    const HOST_ATTR = 'data-keine-actions'
    const ROW_FLAG = 'data-keine-row'

    function rowSeq(node) {
      const data = (node && node.data) || {}
      if (typeof data.seq === 'number') return data.seq
      if (typeof node.anchorSeq === 'number') return node.anchorSeq
      return undefined
    }

    function hideRow(row, hidden) {
      if (hidden) {
        if (row.style.display !== 'none') row.style.display = 'none'
        return
      }
      if (row.style.display === 'none') row.style.display = ''
    }

    // The official user bubble is `userRow > [userStack, actions]`, where
    // `actions` is the small control strip under the bubble that already holds
    // the clock and the copy button. Anchoring there puts our buttons exactly
    // where the other message controls live. If that strip is absent we fall
    // back to the bubble column, then to the flow row.
    function actionAnchor(row) {
      const userRow = row.querySelector('[class*="userRow"]')
      if (userRow !== null) {
        for (const child of userRow.children) {
          const cls = typeof child.className === 'string' ? child.className : ''
          if (cls.includes('userStack')) continue
          return { el: child, mode: 'actions' }
        }
        const stack = userRow.querySelector('[class*="userStack"]')
        if (stack !== null) return { el: stack, mode: 'stack' }
      }
      return { el: row, mode: 'row' }
    }

    function ensureHost(row, seq, controller) {
      const anchor = actionAnchor(row)
      let host = row.querySelector(`[${HOST_ATTR}]`)
      if (host !== null && host.parentElement !== anchor.el) {
        host.remove()
        host = null
      }
      if (host === null) {
        host = document.createElement('span')
        host.setAttribute(HOST_ATTR, '1')
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.textContent = '✎'
        edit.title = zh.edit
        edit.setAttribute('aria-label', zh.edit)
        edit.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          controller.open(seq, 'edit')
        })
        const recall = document.createElement('button')
        recall.type = 'button'
        recall.textContent = '↩'
        recall.title = zh.recall
        recall.setAttribute('aria-label', zh.recall)
        recall.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          controller.open(seq, 'recall')
        })
        host.appendChild(edit)
        host.appendChild(recall)
        if (anchor.mode === 'actions') {
          // Land between the copy button and the clock, so the strip reads
          // "copy · ✎ · ↩ · 16:35" instead of pushing past the time.
          const clock = anchor.el.querySelector('[class*="time"]')
          if (clock !== null && clock.parentElement === anchor.el) anchor.el.insertBefore(host, clock)
          else anchor.el.appendChild(host)
        } else {
          anchor.el.appendChild(host)
        }
      }
      host.dataset.seq = String(seq)
      host.dataset.keineAnchor = anchor.mode
      const position = window.getComputedStyle(anchor.el).position
      if (anchor.mode !== 'actions' && position === 'static') {
        anchor.el.style.position = 'relative'
        anchor.el.setAttribute(ROW_FLAG, '1')
      }
      return host
    }

    function applyDom(snapshot, view, controller) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue
        const key = row.getAttribute('data-chat-flow-key')
        if (!key) continue
        const node = snapshot.nodes.get(key)
        const isUser = node !== undefined && node !== null && node.kind === 'user'
        const seq = isUser ? rowSeq(node) : undefined
        // A recall shadows a whole turn: the prompt AND the reply, the tool
        // rows and the process rows all carry the same `data-chat-turn`, so the
        // turn ledger hides them together. Hiding only the user row would leave
        // the answer standing after its question disappeared.
        const turnAttr = row.getAttribute('data-chat-turn')
        const turn = turnAttr === null || turnAttr === '' ? null : Number(turnAttr)
        const hiddenByTurn = turn !== null && Number.isFinite(turn) && view.hiddenTurns.has(turn)
        const hiddenBySeq = isUser && typeof seq === 'number' && view.hidden.has(seq)
        const stale = row.querySelector(`[${HOST_ATTR}]`)
        if (hiddenByTurn || hiddenBySeq) {
          hideRow(row, true)
          if (stale !== null) stale.remove()
          continue
        }
        hideRow(row, false)
        if (isUser && typeof seq === 'number') ensureHost(row, seq, controller)
        else if (stale !== null) stale.remove()
      }
    }

    // --- react surface --------------------------------------------------------

    function Dialog({ view, controller }) {
      const dialog = view.dialog
      const ref = useRef(null)
      useEffect(() => {
        if (dialog !== null && dialog.mode === 'edit' && ref.current !== null && !dialog.loading) {
          ref.current.focus()
          const length = ref.current.value.length
          ref.current.setSelectionRange(length, length)
        }
      }, [dialog !== null && dialog.mode, dialog !== null && dialog.loading])
      if (dialog === null) return null
      const images = Array.isArray(dialog.images) ? dialog.images : []
      const title = dialog.mode === 'edit' ? zh.editTitle : zh.recallTitle
      return jsx('div', {
        'data-keine-backdrop': '1',
        onClick: (event) => {
          if (event.target === event.currentTarget) controller.close()
        },
        children: jsxs('div', {
          'data-keine-dialog': '1',
          role: 'dialog',
          'aria-modal': 'true',
          children: [
            jsx('h3', { children: title }),
            jsx('p', { children: dialog.mode === 'edit' ? zh.hintEdit : zh.hintRecall }),
            dialog.mode === 'edit'
              ? jsxs('div', {
                  'data-keine-gallery': '1',
                  children: [
                    images.map((image, index) =>
                      jsxs(
                        'div',
                        {
                          'data-keine-thumb': '1',
                          children: [
                            image.thumb
                              ? jsx('img', {
                                  src: image.thumb,
                                  alt: image.name || 'image',
                                  onError: (event) => {
                                    // A thumbnail the host cannot serve (route
                                    // missing on an older host, object gone from
                                    // disk) must not leave a broken-image glyph
                                    // and raw alt text in the picker.
                                    if (event.currentTarget.src !== BROKEN_THUMB) event.currentTarget.src = BROKEN_THUMB
                                  },
                                })
                              : jsx('span', { 'data-keine-thumbplaceholder': '1', children: '🖼' }),
                            jsx('button', {
                              type: 'button',
                              'data-keine-remove': '1',
                              title: zh.removeImage,
                              'aria-label': zh.removeImage,
                              disabled: dialog.busy,
                              onClick: () => controller.removeImage(index),
                              children: '✕',
                            }),
                            jsx('span', {
                              'data-keine-thumbmeta': '1',
                              children: `${image.name || 'image'}${image.width ? ` · ${image.width}×${image.height}` : ''}`,
                            }),
                          ],
                        },
                        `${image.attachmentId || image.name || 'new'}:${index}`,
                      ),
                    ),
                    jsxs('label', {
                      'data-keine-add': '1',
                      title: zh.addImage,
                      children: [
                        '＋',
                        jsx('input', {
                          type: 'file',
                          accept: 'image/*',
                          multiple: true,
                          style: { display: 'none' },
                          disabled: dialog.busy,
                          onChange: (event) => {
                            // Snapshot the files BEFORE clearing the input: an
                            // <input type=file>'s FileList is live, so resetting
                            // `value` empties the very list we are about to read.
                            const files = Array.from(event.target.files || [])
                            event.target.value = ''
                            void controller.addFiles(files)
                          },
                        }),
                      ],
                    }),
                  ],
                })
              : images.length > 0
                ? jsx('p', { children: zh.dropImages(images.length) })
                : null,
            dialog.mode === 'edit'
              ? jsx('textarea', {
                  ref,
                  value: dialog.text,
                  disabled: dialog.loading || dialog.busy,
                  onChange: (event) => controller.setText(event.target.value),
                  onPaste: (event) => {
                    const data = event.clipboardData
                    const files = data ? Array.from(data.files || []).filter((file) => file.type.startsWith('image/')) : []
                    if (files.length === 0) return
                    event.preventDefault()
                    void controller.addFiles(files)
                  },
                })
              : null,
            dialog.error !== null && dialog.error !== undefined
              ? jsx('p', { 'data-keine-error': '1', children: String(dialog.error) })
              : null,
            jsxs('div', {
              'data-keine-row': '1',
              children: [
                jsx('button', {
                  type: 'button',
                  onClick: () => controller.close(),
                  disabled: dialog.busy,
                  children: zh.cancel,
                }),
                jsx('button', {
                  type: 'button',
                  'data-primary': '1',
                  onClick: () => void controller.submit(),
                  disabled: dialog.loading || dialog.busy,
                  children: dialog.mode === 'edit' ? zh.confirmEdit : zh.confirmRecall,
                }),
              ],
            }),
          ],
        }),
      })
    }

    function Overlay({ useChat, controller }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined
      const [view, setView] = useState(() => controller.getSnapshot())
      useEffect(() => controller.subscribe(() => setView(controller.getSnapshot())), [controller])
      useEffect(() => {
        void controller.load()
      }, [controller])
      useEffect(() => {
        applyDom(snapshot, view, controller)
      }, [snapshot, view, controller])
      useEffect(() => {
        let scheduled = false
        const run = () => {
          scheduled = false
          applyDom(snapshot, view, controller)
        }
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [snapshot, view, controller])
      return jsxs(Fragment, { children: [jsx('style', { children: CSS }), jsx(Dialog, { view, controller })] })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new RecallController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }

      ctx.effect(
        () => () => {
          controllers.clear()
          for (const host of document.querySelectorAll(`[${HOST_ATTR}]`)) host.remove()
        },
        'dsh-keine: controllers',
      )

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'keine',
            order: 9,
            inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
          },
          Overlay,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
