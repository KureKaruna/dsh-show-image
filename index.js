/**
 * dsh-show-image — host entry.
 *
 * Registers the model-facing `show_image` tool: it commits an image file to
 * the durable attachment store and returns a canonical value whose
 * `presentationMeta` carries the attachment reference. The projection is
 * persisted verbatim in the `tool/result` session event's `meta` field — a
 * first-class replayable channel — and the browser-side half of this bundle
 * (./client.js) turns each marked result into one chat gallery node, so the
 * USER sees the image. Unlike `read_image`, nothing image-shaped enters the
 * model context, so no route capability gate applies.
 *
 * Deliberately NOT a custom top-level session event type: out-of-vocabulary
 * types without an `ignorable` marker make the persistence read path refuse
 * to reconstruct the whole session, and `Session.append()` offers no way to
 * set that marker.
 */
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-show-image'
export const inject = ['tools', 'fs']

/**
 * Resolve harness packages from the RUNNING host instead of this file's own
 * directory: linked plugins live outside every node_modules ancestor of the
 * profile store, so bare-specifier static imports cannot resolve (and a
 * second installed copy would split class identities like AttachmentError).
 * Primary base is the host entry (process.argv[1]); this module's URL is the
 * fallback for installs that physically live inside a profile.
 */
function hostImportFor() {
  const bases = [process.argv[1], import.meta.url].filter(Boolean)
  return async (spec) => {
    let lastError
    for (const base of bases) {
      try {
        return await import(pathToFileURL(createRequire(base).resolve(spec)).href)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`dsh-show-image: cannot resolve '${spec}' from the running harness install`, { cause: lastError })
  }
}

/** Extension → admitted media type, mirroring the deployment's image policy vocabulary. */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Longest accepted caption; anything longer is truncated, never rejected. */
const CAPTION_MAX_CHARS = 200

/**
 * Replayable user-facing payloads keyed by the executing callId. Nested
 * `run_code` sub-dispatches never compute presentationMeta (top-level only),
 * so execute() stashes its payload here and the tools/code-dispatch-log
 * listener below appends it to the DURABLE LOG COPY of the sub-dispatch as an
 * ImageBlock (the durable reference the attachment route authorizes against)
 * plus a marker text block — a first-class known event type, invisible to the
 * model.
 */
const payloadByCallId = new Map()
const PAYLOAD_MARK_OPEN = '<dsh-show-image-payload>'
const PAYLOAD_MARK_CLOSE = '</dsh-show-image-payload>'
const PAYLOAD_MAP_CAP = 128

function mediaTypeForPath(filePath) {
  const dot = filePath.lastIndexOf('.')
  if (dot <= 0) return undefined
  return MEDIA_TYPES[filePath.slice(dot).toLowerCase()]
}

/** Project one admission failure into a model-actionable message. */
function admissionMessage(displayPath, error, limits) {
  if (error.code === 'IMAGE_DIMENSION_TOO_LARGE')
    return `cannot show "${displayPath}": at least one image side exceeds the ${limits.maxImageDimension}px limit; downscale the image first`
  if (error.code === 'IMAGE_TOO_MANY_PIXELS')
    return `cannot show "${displayPath}": the image exceeds the ${limits.maxImagePixels}-pixel decoded-size limit; downscale the image first`
  if (error.code === 'IMAGE_TOO_LARGE')
    return `cannot show "${displayPath}": the image cannot be stored within the deployment's byte limits; use a smaller copy`
  if (error.code === 'IMAGE_TYPE_MISMATCH')
    return `cannot show "${displayPath}": the file extension declares a different format than the bytes; rename it to match its actual PNG/JPEG/WebP/GIF format`
  return undefined
}

export async function apply(ctx) {
  const { defineTool } = await hostImportFor()('@deepseek-ai/dsh-tools')
  const { AttachmentError } = await hostImportFor()('@deepseek-ai/dsh-attachment')

  // Same gate as read_image's composing plugin: the tool exists only while a
  // durable attachment store is mounted; execution still re-checks. The
  // scoped context authorizes both the attachments face and the inherited fs.
  ctx.inject(['attachments'], (mediaCtx) => {
    mediaCtx.tools.register(defineTool({
      name: 'show_image',
      description: [
        'Send an image file from disk to the USER as a chat attachment in the WebUI.',
        'The image renders in the conversation transcript for the human; it is NOT added to the model context.',
        'Use this when the user asks to see/display/preview an image. Use read_image instead when YOU need to inspect it.',
        'Accepts PNG/JPEG/WebP/GIF; large images are normalized by the attachment store.',
      ].join(' '),
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Path to the image file, resolved by the filesystem backend.',
        },
        caption: {
          type: 'string',
          description: 'Optional one-line caption rendered under the image.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            caption: { type: 'string' },
            image: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.delivered
            ? `<status>delivered</status>\n<path>${value.path}</path>\n<content>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes — rendered to the user's chat transcript.\n</content>`
            : `<status>failed</status>\n<path>${value.path}</path>`,
        }],
        // Replayable user-facing payload. Persisted verbatim in the durable
        // tool/result event's meta; the client half keys its chat gallery on it.
        presentationMeta: (_args, value) => {
          if (value.delivered !== true) return undefined
          return {
            producer: 'dsh-show-image',
            path: value.path,
            ...(typeof value.caption === 'string' && value.caption.length > 0 ? { caption: value.caption } : {}),
            attachment: { ...value.image },
          }
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
        if (filePath.length === 0) throw new Error('file_path must be a non-empty string')
        const mediaType = mediaTypeForPath(filePath)
        if (mediaType === undefined)
          throw new Error(`cannot show "${filePath}": show_image only accepts PNG/JPEG/WebP/GIF paths`)
        const captionRaw = typeof args.caption === 'string' ? args.caption.trim() : ''
        const caption = captionRaw.slice(0, CAPTION_MAX_CHARS)

        const attachments = mediaCtx.get('attachments')
        if (attachments === undefined)
          throw new Error(`cannot show "${filePath}": no attachment service is mounted`)
        if (!attachments.imageLimits.mediaTypes.includes(mediaType))
          throw new Error(`cannot show "${filePath}": ${mediaType} images are not accepted by this deployment`)

        const target = await mediaCtx.fs.resolve(filePath, { signal: exec.signal })
        const displayPath = mediaCtx.fs.processPath(target)
        const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
        const data = await mediaCtx.fs.readBytes(target, exec.signal, byteCap)

        let ref
        try {
          ref = await attachments.saveImage({ data, mediaType, name: basename(displayPath) })
        } catch (error) {
          if (error instanceof AttachmentError) {
            const message = admissionMessage(displayPath, error, attachments.imageLimits)
            if (message !== undefined) throw new Error(message, { cause: error })
          }
          throw error
        }

        const attachment = {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        }
        // Stash for the durable-log enrichment of this nested dispatch.
        payloadByCallId.set(exec.callId, {
          path: displayPath,
          ...(caption.length > 0 ? { caption } : {}),
          attachment,
        })
        if (payloadByCallId.size > PAYLOAD_MAP_CAP) {
          const oldest = payloadByCallId.keys().next().value
          if (oldest !== undefined) payloadByCallId.delete(oldest)
        }
        return {
          delivered: true,
          path: displayPath,
          ...(caption.length > 0 ? { caption } : {}),
          image: attachment,
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `Show image ${args.file_path}`,
          kind: 'read',
          locations: [{ path: args.file_path }],
        }
      },
    }))

    // Enrich the durable log copy of THIS tool's nested sub-dispatches with
    // the replayable payload. Only the logged copy changes — the program got
    // its value already and the model sees neither (same posture as
    // dsh-spill-policy's oversized-result handling).
    ctx.on('tools/code-dispatch-log', async (dispatch, next) => {
      if (dispatch.isError || dispatch.name !== 'show_image') return next()
      const payload = payloadByCallId.get(dispatch.subCallId)
      if (payload === undefined) return next()
      payloadByCallId.delete(dispatch.subCallId)
      const blocks = await next()
      // The structured image block IS the durable reference: the live
      // attachment route authorizes reads by scanning event content for
      // ImageBlocks (imageBlockIn), so without it the browser's
      // session.attachment read is refused as ATTACHMENT_NOT_REFERENCED.
      return [...blocks, {
        type: 'image',
        attachment: { ...payload.attachment },
      }, {
        type: 'text',
        text: PAYLOAD_MARK_OPEN + JSON.stringify(payload) + PAYLOAD_MARK_CLOSE,
      }]
    })
  })
}
