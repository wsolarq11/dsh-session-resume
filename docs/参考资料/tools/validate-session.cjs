// Validate a zstd session artifact: count surface message events (user/message,
// assistant/message, tool/result) that are missing a non-empty message.id.
// Prints a per-session summary. Read-only.
'use strict'
const { readFileSync } = require('node:fs')
const { zstdDecompress } = require('node:zlib')
const { promisify } = require('node:util')
const zstdDe = promisify(zstdDecompress)
const SRCS = process.argv.slice(2)
const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (bh & 1) !== 0
      const blockType = bh >>> 1 & 3
      const blockSize = bh >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) { if (buffer.length - offset < 4) break; offset += 4 }
    frames.push({ start, end: offset })
  }
  return frames
}

let seq = 0
async function validate(path) {
  const buffer = readFileSync(path)
  const frames = scanZstdFrames(buffer)
  const rows = []
  for (const f of frames) {
    const plain = await zstdDe(buffer.subarray(f.start, f.end))
    for (const line of plain.toString('utf8').split('\n')) if (line.trim()) rows.push(line)
  }
  let bad = []
  let totalMsg = 0
  // seq assigned cursor: msg-event rows carry explicit seq; chunk rows expand.
  // Simply iterate rows preserving any seq field.
  for (const l of rows) {
    const rec = JSON.parse(l)
    const t = rec.type
    if (rec.seq0 !== undefined) { /* packed chunk run -> not a msg-event */ continue }
    if (t === 'user/message' || t === 'assistant/message' || t === 'tool/result') {
      totalMsg++
      const m = t === 'user/message' ? rec.data : rec.data.message
      if (!m || typeof m.id !== 'string' || m.id === '') bad.push(rec.seq)
    }
  }
  console.log(`${path}\n  msg-events=${totalMsg}  badNoId=${bad.length}  badSeqs=[${bad.join(', ')}]`)
}

Promise.all(SRCS.map((p) => validate(p))).catch((e) => { console.error('FATAL', e); process.exit(1) })