// dsh-keine — host half.
//
// Two loopback-only JSON routes:
//
//   GET  /api/plugins/keine/messages?sessionId=<id>
//   GET  /api/plugins/keine/message?sessionId=<id>&seq=<n>
//   POST /api/plugins/keine/recall   { sessionId, seq }
//   POST /api/plugins/keine/edit     { sessionId, seq, text }
//
// Why this plugin exists: DSH stores a user message that carries images as ONE
// `user/message` event whose `data.content` is an array of blocks, e.g.
//
//   [{ type: 'image', attachment: { attachmentId: 'sha256:…', mediaType, width, height, name } },
//    { type: 'text', text: '…' }]
//
// so an image is not a side channel: shadowing that event's seq removes the
// pictures together with the text, and re-sending the SAME image blocks reuses
// the durable content-addressed attachment objects (no upload, no receipt).
//
// Recall appends one `user/message` carrier carrying the official surface intent
// `{ surfaceOp: { op: 'replace', startSeq, endSeq } }`; the original bytes stay
// in the append-only log. Edit does the same and then hands a fresh user message
// — original image blocks + the new text — to the live agent through
// `agent.followup()`, which appends it at the start of the next turn.
//
// The module imports nothing from the DSH SDK: `sessions`, `sessionQuery`,
// `agents` and `webServer` are resolved through the cordis context at call time,
// so the plugin loads on any profile and fails with a clear HTTP error when a
// service is absent.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-keine'

const PLUGIN_ID = 'dsh-keine'
const ROUTE_PREFIX = '/api/plugins/keine'
// A session id is an opaque string to DSH, but never one that could leave a
// path or a URL.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// Pasting a screenshot sends base64 (≈4/3 of the bytes), so the body cap has to
// clear a realistic batch of images; the attachment service still enforces its
// own per-image and per-message limits.
const MAX_BODY_BYTES = 24 * 1024 * 1024
const FLUSH_TIMEOUT_MS = 5000

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// --- http helpers ------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'too-large', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false
  const host = hostHeader.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  return true
}

function sessionIdFromQuery(url) {
  return new URL(url || '/', 'http://localhost').searchParams.get('sessionId') || ''
}

function requireSessionId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id.length === 0) throw new HttpError(400, 'invalid', 'sessionId required')
  if (!SESSION_ID_RE.test(id)) throw new HttpError(400, 'invalid', 'invalid session id')
  return id
}

// --- session access ----------------------------------------------------------

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(sessionId)
  } catch {
    return undefined
  }
}

function requireLiveSession(ctx, sessionId) {
  const session = findLiveSession(ctx, sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-live', 'this session is not open in the running host; open it first')
  }
  return session
}

// Live-preferred read through the public query service; the live session's own
// snapshot is the fallback when the service is absent.
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
    } catch {
      // fall through
    }
  }
  const live = findLiveSession(ctx, sessionId)
  if (live && typeof live.snapshotEvents === 'function') {
    try {
      return live.snapshotEvents()
    } catch {
      return null
    }
  }
  return null
}

async function flushSession(ctx, session) {
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await Promise.race([sessions.flush(session), new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))])
      return { flushed: true }
    } catch (error) {
      return { flushed: false, flushError: String((error && error.message) || error) }
    }
  }
  return { flushed: false, flushError: 'sessions.flush unavailable' }
}

// --- surface fold ------------------------------------------------------------

// The live surface: every event that currently projects into the model context,
// in ascending seq order. A replacement drops the nodes it covers and becomes a
// node itself; log-only events (no `surfaceOp`) never enter.
function foldSurface(events) {
  const nodes = []
  for (const event of events) {
    const op = event && event.surfaceOp
    if (op === undefined || op === null) continue
    if (op === 'append') {
      nodes.push(event)
      continue
    }
    if (typeof op !== 'object' || op.op !== 'replace') continue
    const start = Number.isSafeInteger(op.startSeq) ? op.startSeq : op.start
    const end = Number.isSafeInteger(op.endSeq) ? op.endSeq : op.end
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue
    const kept = nodes.filter((node) => node.seq < start || node.seq > end)
    kept.push(event)
    nodes.length = 0
    for (const node of kept) nodes.push(node)
  }
  return nodes.sort((a, b) => a.seq - b.seq)
}

// Turn number of every event, derived from the `turn/start` markers in order.
function turnsOf(events) {
  const turns = new Map()
  let current = null
  for (const event of events) {
    if (event && event.type === 'turn/start') {
      const turn = event.data && Number.isSafeInteger(event.data.turn) ? event.data.turn : null
      current = turn !== null ? turn : current === null ? 1 : current + 1
    }
    if (current !== null && event && Number.isSafeInteger(event.seq)) turns.set(event.seq, current)
  }
  return turns
}

function blocksOf(event) {
  const content = event && event.data && Array.isArray(event.data.content) ? event.data.content : []
  return content
}

function textOf(event) {
  return blocksOf(event)
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function imagesOf(event) {
  return blocksOf(event)
    .filter((block) => block && block.type === 'image' && block.attachment && typeof block.attachment.attachmentId === 'string')
    .map((block) => ({
      attachmentId: block.attachment.attachmentId,
      mediaType: block.attachment.mediaType,
      width: block.attachment.width,
      height: block.attachment.height,
      name: block.attachment.name,
    }))
}

// The plugin used to be called dsh-image-recall; carriers written back then
// still own their windows, so a rename must not resurrect recalled turns.
const LEGACY_PLUGIN_IDS = ['dsh-image-recall']

function isCarrier(event) {
  const source = event && event.data && event.data.source
  if (!source || typeof source.kind !== 'string' || !source.kind.startsWith('plugin:')) return false
  const id = source.kind.slice('plugin:'.length)
  return id === PLUGIN_ID || LEGACY_PLUGIN_IDS.includes(id)
}

// Only a real prompt is editable. The harness also appends `user/message`
// events for runtime context, the skill catalog and model-switch notices; those
// carry their own `source.kind` and must never be recalled.
function isRealUserMessage(event) {
  const source = event && event.data && event.data.source
  return Boolean(source && source.kind === 'user')
}

// --- operations --------------------------------------------------------------

// Read one stored image back for the picker's thumbnails. The attachment
// service owns the location; the content-addressed layout is only the fallback
// for backends that do not expose it.
function storedObjectPath(attachmentId) {
  if (typeof attachmentId !== 'string') return null
  const hex = attachmentId.startsWith('sha256:') ? attachmentId.slice(7) : attachmentId
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null
  return join(homedir(), '.dsh', 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
}

async function imageFile(ctx, ref) {
  const attachments = ctx.get('attachments')
  let hostPath = null
  if (attachments && typeof attachments.imageHostPath === 'function') {
    try {
      hostPath = attachments.imageHostPath(ref) ?? null
    } catch {
      hostPath = null
    }
  }
  if (hostPath === null) hostPath = storedObjectPath(ref && ref.attachmentId)
  if (hostPath === null) return null
  try {
    return await readFile(hostPath)
  } catch {
    return null
  }
}

async function loadView(ctx, sessionId) {
  const events = await readEvents(ctx, sessionId)
  if (!Array.isArray(events)) throw new HttpError(409, 'session-not-found', 'cannot read this session log')
  const nodes = foldSurface(events)
  const turns = turnsOf(events)
  const carriers = events.filter(isCarrier)
  const hidden = []
  const hiddenTurns = new Set()
  for (const carrier of carriers) {
    const shadowed = Array.isArray(carrier.sourceEventSeqs) ? carrier.sourceEventSeqs : []
    for (const seq of shadowed) {
      if (Number.isSafeInteger(seq)) hidden.push(seq)
      const turn = turns.get(seq)
      if (turn !== undefined) hiddenTurns.add(turn)
    }
    const ownTurn = turns.get(carrier.seq)
    if (ownTurn !== undefined) hiddenTurns.add(ownTurn)
    // The carrier is itself a live surface node (a zero-width user message);
    // the transcript must not leave a blank bubble behind for it.
    hidden.push(carrier.seq)
  }
  const messages = []
  for (const node of nodes) {
    if (node.type !== 'user/message' || isCarrier(node) || !isRealUserMessage(node)) continue
    messages.push({
      seq: node.seq,
      turn: turns.get(node.seq) ?? null,
      text: textOf(node),
      images: imagesOf(node),
    })
  }
  return { events, nodes, turns, messages, hidden, hiddenTurns: [...hiddenTurns], carriers: carriers.map((c) => c.seq) }
}

function agentOf(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

function agentBusy(agent) {
  if (!agent) return false
  try {
    return agent.status === 'running'
  } catch {
    return false
  }
}

// The range a recall/edit shadows: the target user message through the last
// live surface node. Re-asking from a point in the past is exactly "truncate
// the conversation at that point and continue".
function planRange(view, seq) {
  const node = view.nodes.find((entry) => entry.seq === seq)
  if (!node) throw new HttpError(409, 'stale', 'that message is no longer in the live surface')
  if (node.type !== 'user/message') throw new HttpError(400, 'not-user-message', 'only user messages can be recalled or edited')
  if (isCarrier(node)) throw new HttpError(400, 'not-user-message', 'that row belongs to this plugin')
  if (!isRealUserMessage(node)) throw new HttpError(400, 'not-user-message', 'only prompts you typed can be recalled or edited')
  const tail = view.nodes[view.nodes.length - 1]
  if (!tail || tail.seq < seq) throw new HttpError(409, 'stale', 'nothing to shadow')
  const shadowed = view.nodes.filter((entry) => entry.seq >= seq).map((entry) => entry.seq)
  return { startSeq: seq, endSeq: tail.seq, shadowed }
}

function appendCarrier(session, plan, op, targetSeq) {
  return session.append(
    'user/message',
    {
      id: randomUUID(),
      role: 'user',
      // A zero-width space, not an empty list: an empty user message is refused
      // by strict providers ("user message must have content").
      content: [{ type: 'text', text: '\u200b' }],
      source: { kind: `plugin:${PLUGIN_ID}`, op, targetSeq },
    },
    {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    },
  )
}

// Append the replacement carrier and then close the read/append race: an
// assistant reply that landed between our log read and this append sits after
// the planned window, so it would survive the recall and leave an answer
// standing without its question. One re-read and one extra carrier fix that.
async function appendShadow(ctx, session, sessionId, plan, op, targetSeq) {
  let carrier = appendCarrier(session, plan, op, targetSeq)
  await flushSession(ctx, session)
  let after = null
  try {
    after = await loadView(ctx, sessionId)
  } catch {
    return carrier
  }
  const extra = after.nodes.filter((node) => node.seq > plan.endSeq && !isCarrier(node))
  if (extra.length === 0) return carrier
  const tailPlan = {
    startSeq: extra[0].seq,
    endSeq: extra[extra.length - 1].seq,
    shadowed: extra.map((node) => node.seq),
  }
  carrier = appendCarrier(session, tailPlan, `${op}-tail`, targetSeq)
  await flushSession(ctx, session)
  return carrier
}

async function recallTarget(ctx, sessionId, seq) {
  const session = requireLiveSession(ctx, sessionId)
  const view = await loadView(ctx, sessionId)
  const plan = planRange(view, seq)
  const agent = agentOf(ctx, sessionId)
  if (agentBusy(agent)) throw new HttpError(409, 'busy', 'this session is running; wait for the reply to finish')
  const carrier = await appendShadow(ctx, session, sessionId, plan, 'recall', seq)
  const flush = await flushSession(ctx, session)
  return {
    carrierSeq: carrier.seq,
    shadowed: plan.shadowed,
    hiddenTurns: plan.shadowed.map((s) => view.turns.get(s)).filter((t) => t !== undefined),
    ...flush,
  }
}

async function editTarget(ctx, sessionId, seq, text, selection) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) throw new HttpError(400, 'blank-text', 'the edited message must not be empty')
  const session = requireLiveSession(ctx, sessionId)
  const view = await loadView(ctx, sessionId)
  const plan = planRange(view, seq)
  const target = view.nodes.find((entry) => entry.seq === seq)
  const agent = agentOf(ctx, sessionId)
  if (!agent || typeof agent.followup !== 'function') {
    throw new HttpError(409, 'agent-unavailable', 'no live agent for this session; open it first')
  }
  if (agentBusy(agent)) throw new HttpError(409, 'busy', 'this session is running; wait for the reply to finish')
  const content = await editedContent(ctx, target, trimmed, selection)
  const carrier = await appendShadow(ctx, session, sessionId, plan, 'edit', seq)
  const message = {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user', rpcId: randomUUID() },
  }
  agent.followup(message)
  return {
    carrierSeq: carrier.seq,
    shadowed: plan.shadowed,
    hiddenTurns: plan.shadowed.map((s) => view.turns.get(s)).filter((t) => t !== undefined),
    resendId: message.id,
    images: content.filter((block) => block && block.type === 'image').length,
  }
}

// Compose the re-sent content from three sources, in this order:
//   1. the image blocks the caller chose to keep, copied verbatim from the
//      original event (full reference, so the store can verify metadata);
//   2. freshly pasted/dropped images, admitted through the official
//      `admitPromptContent` path (normalization, batch limits, dedup);
//   3. the edited text.
// Without a selection every original image is kept, which is the pre-picker
// behaviour.
async function editedContent(ctx, target, text, selection) {
  const original = blocksOf(target).filter((block) => block && block.type === 'image' && block.attachment)
  const keepIds = selection && Array.isArray(selection.keep) ? new Set(selection.keep) : null
  const kept = keepIds === null ? original : original.filter((block) => keepIds.has(block.attachment.attachmentId))
  const uploads = selection && Array.isArray(selection.uploads) ? selection.uploads : []
  const content = kept.map((block) => ({ type: 'image', attachment: block.attachment }))
  if (uploads.length > 0) {
    const attachments = ctx.get('attachments')
    if (!attachments || typeof attachments.admitPromptContent !== 'function') {
      throw new HttpError(500, 'no-attachments', 'the attachment service is not available on this host')
    }
    const encoded = uploads.map((upload) => ({
      type: 'image',
      data: String(upload.data ?? ''),
      mediaType: String(upload.mediaType ?? 'image/png'),
      ...(typeof upload.name === 'string' && upload.name !== '' ? { name: upload.name } : {}),
    }))
    let admitted
    try {
      admitted = await attachments.admitPromptContent(encoded)
    } catch (error) {
      throw new HttpError(400, 'image-refused', String((error && error.message) || error))
    }
    for (const part of admitted) {
      if (part && part.type === 'image' && part.attachment) content.push({ type: 'image', attachment: part.attachment })
    }
  }
  content.push({ type: 'text', text })
  return content
}

// --- http --------------------------------------------------------------------

export function apply(ctx) {
  const registerRoutes = (webServer, fiber) => {
    const route = (path, handler) => {
      fiber.effect(() =>
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              await handler(req, res)
            } catch (error) {
              const status = error instanceof HttpError ? error.status : 500
              const code = error instanceof HttpError ? error.code : 'internal'
              const details = error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}
              sendJson(res, status, { ok: false, code, error: String((error && error.message) || error), ...details })
            }
          },
        }),
      )
    }

    route(`${ROUTE_PREFIX}/messages`, async (req, res) => {
      if (req.method !== 'GET') throw new HttpError(405, 'method', 'GET only')
      const sessionId = requireSessionId(sessionIdFromQuery(req.url))
      const view = await loadView(ctx, sessionId)
      sendJson(res, 200, {
        ok: true,
        version: '0.3.0',
        messages: view.messages,
        hidden: view.hidden,
        hiddenTurns: view.hiddenTurns,
        carriers: view.carriers,
        busy: agentBusy(agentOf(ctx, sessionId)),
      })
    })

    route(`${ROUTE_PREFIX}/message`, async (req, res) => {
      if (req.method !== 'GET') throw new HttpError(405, 'method', 'GET only')
      const url = new URL(req.url || '/', 'http://localhost')
      const sessionId = requireSessionId(url.searchParams.get('sessionId') || '')
      const seq = Number(url.searchParams.get('seq'))
      if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid', 'seq required')
      const view = await loadView(ctx, sessionId)
      const node = view.nodes.find((entry) => entry.seq === seq)
      if (!node) throw new HttpError(404, 'not-found', 'that message is not in the live surface')
      sendJson(res, 200, { ok: true, seq, text: textOf(node), images: imagesOf(node), turn: view.turns.get(seq) ?? null })
    })

    route(`${ROUTE_PREFIX}/recall`, async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only')
      const body = await parseBody(req)
      const sessionId = requireSessionId(body.sessionId)
      const seq = Number(body.seq)
      if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid', 'seq required')
      sendJson(res, 200, { ok: true, ...(await recallTarget(ctx, sessionId, seq)) })
    })

    route(`${ROUTE_PREFIX}/edit`, async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only')
      const body = await parseBody(req)
      const sessionId = requireSessionId(body.sessionId)
      const seq = Number(body.seq)
      if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid', 'seq required')
      const selection =
        Array.isArray(body.keep) || Array.isArray(body.uploads)
          ? { keep: body.keep, uploads: body.uploads }
          : undefined
      sendJson(res, 200, { ok: true, ...(await editTarget(ctx, sessionId, seq, body.text, selection)) })
    })

    // Thumbnails for the images already attached to a message. The bytes come
    // from the durable store; the request has to name the message it belongs to
    // so the route can confirm the reference is really part of this session.
    route(`${ROUTE_PREFIX}/image`, async (req, res) => {
      if (req.method !== 'GET') throw new HttpError(405, 'method', 'GET only')
      const url = new URL(req.url || '/', 'http://localhost')
      const sessionId = requireSessionId(url.searchParams.get('sessionId') || '')
      const seq = Number(url.searchParams.get('seq'))
      const id = url.searchParams.get('id') || ''
      if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'invalid', 'seq required')
      if (id === '') throw new HttpError(400, 'invalid', 'id required')
      const view = await loadView(ctx, sessionId)
      const node = view.nodes.find((entry) => entry.seq === seq)
      if (!node) throw new HttpError(404, 'not-found', 'that message is not in the live surface')
      const ref = blocksOf(node)
        .filter((block) => block && block.type === 'image' && block.attachment)
        .map((block) => block.attachment)
        .find((attachment) => attachment.attachmentId === id)
      if (!ref) throw new HttpError(404, 'not-found', 'that image is not part of this message')
      const file = await imageFile(ctx, ref)
      if (file === null) throw new HttpError(404, 'not-found', 'the stored image is unavailable')
      res.statusCode = 200
      res.setHeader('content-type', ref.mediaType || 'application/octet-stream')
      res.setHeader('cache-control', 'private, max-age=300')
      res.end(file)
    })
  }

  async function parseBody(req) {
    const raw = await readBody(req)
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      throw new HttpError(400, 'invalid', 'malformed JSON body')
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }
}
