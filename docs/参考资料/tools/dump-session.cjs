// Diagnostic: decode a multi-frame zstd session artifact into JSONL rows and
// locate the event at the given seq. Read-only; writes decoded plaintext to a
// scratch file and prints the target event. Does not modify the session file.
'use strict'
const { readFileSync, writeFileSync } = require('node:fs')
const { zstdDecompress } = require('node:zlib')
const { promisify } = require('node:util')
const zstdDe = promisify(zstdDecompress)

const SRC = process.argv[2]
const OUT = process.argv[3]
const TARGET_SEQ = process.argv[4] ? Number(process.argv[4]) : -1

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE

// Replica of dsh-session-persistence-jsonl scanZstdFrames: returns complete
// frame {start,end} ranges (and tornStart for an incomplete final frame).
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  let tornStart = -1
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) { tornStart = start; break }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) { tornStart = start; break }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) { tornStart = start; break }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) { tornStart = start; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { tornStart = start; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) { tornStart = start; break }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart }
}

async function main() {
  const buffer = readFileSync(SRC)
  const { frames, tornStart } = scanZstdFrames(buffer)
  console.error(`frames=${frames.length} tornStart=${tornStart} fileBytes=${buffer.length}`)
  const rows = []
  for (const f of frames) {
    const plain = await zstdDe(buffer.subarray(f.start, f.end))
    const text = plain.toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      rows.push(line)
    }
  }
  if (OUT) writeFileSync(OUT, rows.join('\n'))
  console.log(`rows=${rows.length}`)

  // Build seq -> event by decoding storage records. A storage record may hold
  // one or more events; walk rows preserving seq order.
  let seq = 0
  const bySeq = new Map()
  for (const line of rows) {
    const rec = JSON.parse(line)
    // storage record shapes: {type:"session",...} header, then event rows.
    if (rec.type === 'session') continue
    const events = decodeRecord(rec)
    for (const ev of events) {
      bySeq.set(seq, { line, ev })
      seq++
    }
  }
  console.log(`total decoded events (by seq) = ${seq}`)
  if (TARGET_SEQ >= 0) {
    const t = bySeq.get(TARGET_SEQ)
    if (!t) { console.log(`TARGET ${TARGET_SEQ}: NOT PRESENT (max seq ${seq - 1})`) }
    else {
      console.log(`\n=== seq ${TARGET_SEQ} event ===`)
      console.log(JSON.stringify(t.ev, null, 2))
      console.log('\n=== raw JSONL line ===')
      console.log(t.line)
    }
    // Also dump a small context window around the target
    console.log('\n=== seq window around target ===')
    for (let s = Math.max(0, TARGET_SEQ - 3); s <= Math.min(seq - 1, TARGET_SEQ + 3); s++) {
      const e = bySeq.get(s)
      console.log(`seq ${s}:`, e ? trunc(e.ev) : 'MISSING')
    }
  }
}

function decodeRecord(rec) {
  // Three storage row shapes:
  //  1. plain event envelope   {type, seq, time, data}  -> one event.
  //  2. packed chunk run       {type: text-chunks|reasoning-chunks|tool-call-chunks, seq0, time0, data:{...payload[]}}
  //     -> N delta chunk events at seq0..seq0+N-1.
  if (rec.seq0 !== undefined) {
    const data = rec.data
    const payload = data.texts || data.args
    const n = payload.length
    const dt = data.dt || []
    const events = []
    let prevTime = rec.time0
    for (let i = 0; i < n; i++) {
      const seq = rec.seq0 + i
      const chunk = makeChunk(data, i)
      events.push({
        type: chunkType(rec.type),
        seq,
        time: i === 0 ? rec.time0 : rec.time0 + prefixSum(dt, i),
        data: { turn: data.turn, step: data.step, chunk },
      })
      // Be robust even if times drift; seq mapping is what matters for lookup.
    }
    return events
  }
  return [rec]
}
function prefixSum(arr, upto) { let s = 0; for (let i = 0; i < upto && i < arr.length; i++) s += arr[i]; return s }
function chunkType(rowType) {
  if (rowType === 'text-chunks') return 'assistant/chunk'
  if (rowType === 'reasoning-chunks') return 'assistant/chunk'
  if (rowType === 'tool-call-chunks') return 'assistant/chunk'
  return rowType
}
function makeChunk(data, i) {
  const base = { type: data.text ? 'text-delta' : data.args ? 'tool-call-delta' : 'reasoning-delta', index: data.index }
  if (data.text) return { ...base, text: data.text[i] }
  if (data.args) return { ...base, id: data.id, ...(data.name !== undefined ? { name: data.name } : {}), argumentsDelta: data.args[i] }
  return { ...base, text: data.texts ? data.texts[i] : '' }
}

function trunc(o) {
  const s = JSON.stringify(o)
  return s.length > 400 ? s.slice(0, 400) + '…' : s
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })