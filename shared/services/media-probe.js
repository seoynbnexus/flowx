const CODEC_MAP = {
  avc1: 'avc1',
  avc3: 'avc1',
  hvc1: 'hvc1',
  hev1: 'hvc1',
  mp4a: 'mp4a',
}

const CHROMA_SUBSAMPLING_MAP = {
  0x00: '4:2:0',
  0x01: '4:2:2',
  0x02: '4:4:4',
}

const DEFAULT_PROBE_LIMITS = {
  maxDepth: 64,
  maxBoxes: 2048,
  maxStsdCount: 64,
  maxSampleEntries: 4096,
}

const JPEG_SOI = 0xffd8

function fail(reason) {
  return { status: 'invalid', kind: null, reason }
}

function notContainer() {
  return { status: 'unknown', kind: null, reason: 'unrecognized container (not JPEG or ISO-BMFF)' }
}

function parseJpeg(buffer) {
  const maxOffset = buffer.length - 1
  let offset = 2
  let width = null
  let height = null
  let orientation = 1
  let sawFrame = false
  let sawEoi = false

  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

  const scanToNextMarker = (start) => {
    let pos = start
    while (pos + 1 <= maxOffset) {
      if (buffer[pos] !== 0xff) {
        pos += 1
        continue
      }
      const next = buffer[pos + 1]
      if (next === 0x00) {
        pos += 2
        continue
      }
      if (next >= 0xd0 && next <= 0xd7) {
        pos += 2
        continue
      }
      return pos
    }
    return -1
  }

  while (offset <= maxOffset) {
    if (buffer[offset] !== 0xff) return fail(`invalid JPEG marker byte at offset 0x${offset.toString(16)}`)
    while (offset <= maxOffset && buffer[offset] === 0xff) offset += 1
    if (offset > maxOffset) return fail('truncated JPEG (marker runs off end)')
    const marker = buffer[offset]
    offset += 1

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) {
        sawEoi = true
        break
      }
      continue
    }
    if (marker === 0x00 || marker === 0xff) continue

    if (marker === 0xda) {
      if (offset + 2 > maxOffset) return fail('truncated JPEG segment length')
      const segLen = buffer.readUInt16BE(offset)
      offset += 2
      if (segLen < 2) return fail(`invalid JPEG segment length ${segLen}`)
      const payloadEnd = offset + segLen - 2
      if (payloadEnd > buffer.length) return fail('truncated JPEG segment payload')
      offset = scanToNextMarker(payloadEnd)
      if (offset < 0) return fail('truncated JPEG scan data (no marker after SOS)')
      continue
    }

    if (offset + 2 > maxOffset) return fail('truncated JPEG segment length')
    const segLen = buffer.readUInt16BE(offset)
    offset += 2
    if (segLen < 2) return fail(`invalid JPEG segment length ${segLen}`)
    const payloadStart = offset
    const payloadEnd = offset + segLen - 2
    if (payloadEnd > buffer.length) return fail('truncated JPEG segment payload')

    if (frameMarkers.has(marker)) {
      if (payloadEnd < payloadStart + 5) return fail('truncated JPEG SOF segment')
      const precision = buffer[payloadStart]
      const h = buffer.readUInt16BE(payloadStart + 1)
      const w = buffer.readUInt16BE(payloadStart + 3)
      if (precision === 0) return fail('invalid JPEG precision (0)')
      if (w === 0 || h === 0) return fail(`invalid JPEG dimensions ${w}x${h}`)
      width = w
      height = h
      sawFrame = true
    }

    if (marker === 0xe1) {
      if (payloadStart + 6 <= payloadEnd && buffer.toString('ascii', payloadStart, payloadStart + 5) === 'Exif\0') {
        orientation = readJpegOrientation(buffer, payloadStart + 6, payloadEnd)
      }
    }

    offset = payloadEnd
  }

  if (!sawFrame) return fail('JPEG has no frame header (SOF)')
  if (!sawEoi) return fail('truncated JPEG (missing EOI marker)')
  if (offset < maxOffset) return fail('JPEG has trailing bytes after EOI')

  return {
    status: 'valid',
    kind: 'image',
    mediaType: 'jpeg',
    width,
    height,
    aspect: width / height,
    orientation,
    sizeBytes: buffer.length,
  }
}

function readJpegOrientation(buffer, tiffStart, tiffEnd) {
  if (tiffStart + 8 > tiffEnd) return 1
  const endian = buffer.toString('ascii', tiffStart, tiffStart + 2)
  if (endian !== 'II' && endian !== 'MM') return 1
  const littleEndian = endian === 'II'
  const read16 = (p) => (littleEndian ? buffer.readUInt16LE(p) : buffer.readUInt16BE(p))
  const read32 = (p) => (littleEndian ? buffer.readUInt32LE(p) : buffer.readUInt32BE(p))
  if (read16(tiffStart + 2) !== 42) return 1
  const ifdStart = tiffStart + read32(tiffStart + 4)
  if (ifdStart + 2 > tiffEnd) return 1
  const entryCount = read16(ifdStart)
  for (let i = 0; i < entryCount && ifdStart + 2 + (i + 1) * 12 <= tiffEnd; i += 1) {
    const entry = ifdStart + 2 + i * 12
    const tag = read16(entry)
    const valueType = read16(entry + 2)
    if (tag === 0x0112 && valueType === 3) {
      const val = read16(entry + 8)
      if (val >= 1 && val <= 8) return val
    }
  }
  return 1
}

function probeMp4(buffer) {
  if (buffer.length < 8) return fail('truncated media (fewer than 8 bytes)')
  const boxSize = buffer.readUInt32BE(0)
  const boxType = buffer.toString('ascii', 4, 8)
  if (boxType !== 'ftyp') return fail('missing ftyp box (not ISO-BMFF)')
  if (boxSize === 0 || boxSize < 8) return fail('invalid ISO-BMFF top box size')

  const state = {
    moovFound: false,
    moovAfterMdat: false,
    mdatOffset: null,
    fragmented: false,
    timescale: null,
    duration: null,
    width: null,
    height: null,
    rotation: 0,
    codecs: [],
    stsdParsed: 0,
    boxesParsed: 0,
  }

  const containerBoxes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'mfra'])

  const parseBoxes = (start, end, depth) => {
    if (depth > DEFAULT_PROBE_LIMITS.maxDepth) return
    let pos = start
    while (pos + 8 <= end) {
      state.boxesParsed += 1
      if (state.boxesParsed > DEFAULT_PROBE_LIMITS.maxBoxes) return
      let size = buffer.readUInt32BE(pos)
      const type = buffer.toString('ascii', pos + 4, pos + 8)
      let headerSize = 8
      if (size === 1) {
        if (pos + 16 > end) return
        size = Number(buffer.readBigUInt64BE(pos + 8))
        headerSize = 16
      } else if (size === 0) {
        size = end - pos
      }
      if (size < headerSize || pos + size > end) return
      const bodyStart = pos + headerSize
      const bodyEnd = pos + size

      if (type === 'moov') {
        state.moovFound = true
        if (state.mdatOffset !== null && pos > state.mdatOffset) state.moovAfterMdat = true
        parseBoxes(bodyStart, bodyEnd, depth + 1)
      } else if (type === 'mdat') {
        state.mdatOffset = pos
      } else if (type === 'moof') {
        state.fragmented = true
      } else if (type === 'mvhd') {
        parseMvhd(buffer, bodyStart, bodyEnd, state)
      } else if (type === 'tkhd') {
        parseTkhd(buffer, bodyStart, bodyEnd, state)
      } else if (type === 'stsd') {
        parseStsd(buffer, bodyStart, bodyEnd, state)
      } else if (containerBoxes.has(type)) {
        parseBoxes(bodyStart, bodyEnd, depth + 1)
      }
      pos += size
    }
  }

  parseBoxes(0, buffer.length, 0)

  if (!state.moovFound) {
    if (state.fragmented) {
      return {
        status: 'unknown',
        kind: 'video',
        mediaType: 'mp4',
        reason: 'fragmented ISO-BMFF without moov — cannot fully validate',
        fragmented: true,
        sizeBytes: buffer.length,
      }
    }
    return fail('ISO-BMFF has no moov box (not a playable video)')
  }

  return {
    status: 'valid',
    kind: 'video',
    mediaType: 'mp4',
    width: state.width,
    height: state.height,
    aspect: state.width && state.height ? state.width / state.height : null,
    durationSeconds: state.duration != null && state.timescale ? state.duration / state.timescale : null,
    rotation: state.rotation,
    codecs: state.codecs,
    fragmented: state.fragmented,
    moovAfterMdat: state.moovAfterMdat,
    sizeBytes: buffer.length,
  }
}

function parseMvhd(buffer, bodyStart, bodyEnd, state) {
  if (bodyEnd - bodyStart < 12) return
  const version = buffer[bodyStart]
  let pos = bodyStart
  if (version === 1) {
    pos += 20
    if (pos + 16 > bodyEnd) return
    state.timescale = buffer.readUInt32BE(pos)
    state.duration = Number(buffer.readBigUInt64BE(pos + 4))
  } else {
    pos += 12
    if (pos + 8 > bodyEnd) return
    state.timescale = buffer.readUInt32BE(pos)
    state.duration = buffer.readUInt32BE(pos + 4)
  }
}

function parseTkhd(buffer, bodyStart, bodyEnd, state) {
  if (bodyEnd - bodyStart < 8) return
  const version = buffer[bodyStart]
  let pos = bodyStart
  if (version === 1) {
    pos += 88
  } else {
    pos += 76
  }
  if (pos + 8 > bodyEnd) return

  const rotationStart = pos - 36
  if (rotationStart >= bodyStart && rotationStart + 16 <= bodyEnd) {
    const a = buffer.readInt32BE(rotationStart) / 65536
    const b = buffer.readInt32BE(rotationStart + 4) / 65536
    let angle = Math.atan2(b, a)
    if (angle < 0) angle += 2 * Math.PI
    state.rotation = Math.round((angle * 180) / Math.PI) % 360
  }

  const widthFixed = buffer.readUInt32BE(pos)
  const heightFixed = buffer.readUInt32BE(pos + 4)
  const w = widthFixed / 65536
  const h = heightFixed / 65536
  if (w > 0 && h > 0) {
    state.width = Math.round(w)
    state.height = Math.round(h)
  }
}

function parseStsd(buffer, bodyStart, bodyEnd, state) {
  state.stsdParsed += 1
  if (state.stsdParsed > DEFAULT_PROBE_LIMITS.maxStsdCount) return
  if (bodyEnd - bodyStart < 8) return
  let pos = bodyStart + 4
  const entryCount = buffer.readUInt32BE(pos)
  pos += 4
  const limit = Math.min(entryCount, DEFAULT_PROBE_LIMITS.maxSampleEntries)
  for (let i = 0; i < limit && pos + 16 <= bodyEnd; i += 1) {
    const size = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    if (type in CODEC_MAP) {
      state.codecs.push(CODEC_MAP[type])
    }
    if (size < 8) break
    pos += size
  }
}

export function probeMedia(buffer) {
  if (!buffer || buffer.length < 2) return fail('truncated media (fewer than 2 bytes)')

  const firstTwo = buffer.readUInt16BE(0)
  if (firstTwo === JPEG_SOI) return parseJpeg(buffer)

  if (buffer.length >= 8) {
    const topType = buffer.toString('ascii', 4, 8)
    if (topType === 'ftyp') return probeMp4(buffer)
  }
  return notContainer()
}

export async function probeWithFfprobe(filePath, { timeoutMs = 15000 } = {}) {
  const { execFile } = await import('node:child_process')
  const result = await new Promise((resolve) => {
    const child = execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    )
    child.on('error', (err) => resolve({ err }))
  })
  if (result.err) {
    return { status: 'invalid', reason: result.stderr?.trim() || result.err.message, ffprobe: true }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video')
    const format = parsed.format || {}
    return {
      status: 'valid',
      kind: videoStream ? 'video' : 'image',
      mediaType: format.format_name ? String(format.format_name).split(',')[0] : null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      aspect: videoStream && videoStream.width ? videoStream.width / videoStream.height : null,
      durationSeconds: parseFloat(format.duration || videoStream?.duration || '0') || null,
      rotation: 0,
      codecs: videoStream ? [CODEC_MAP[videoStream.codec_name] || videoStream.codec_name] : [],
      sizeBytes: parseInt(format.size || '0', 10) || null,
      ffprobe: true,
    }
  } catch {
    return { status: 'invalid', reason: 'invalid ffprobe output', ffprobe: true }
  }
}
