// Port of scripts/local/snapshot.cs: authenticated SQLCipher pages and committed WAL only.
// Plaintext exists only in memory; the original database is never modified.
import fs from 'node:fs'
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto'

const PAGE = 4096, MAX_PAGES = 131072
const check = (condition) => { if (!condition) throw Error('Invalid encrypted snapshot') }
function read(file, optional = false) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    check(size <= MAX_PAGES * 4120 + 32)
    const data = Buffer.alloc(size)
    for (let at = 0; at < size;) {
      const n = fs.readSync(fd, data, at, size - at, at)
      check(n > 0); at += n
    }
    return data
  } catch (error) {
    if (optional && error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function macKey(key, db) {
  return pbkdf2Sync(key, db.subarray(0, 16).map(b => b ^ 0x3a), 2, 32, 'sha512')
}
function authenticated(input, offset, number, mac) {
  const skip = number === 1 ? 16 : 0, index = Buffer.alloc(4)
  index.writeUInt32LE(number)
  const hash = createHmac('sha512', mac).update(input.subarray(offset + skip, offset + 4032)).update(index).digest()
  return timingSafeEqual(hash, input.subarray(offset + 4032, offset + PAGE))
}
export function verifyKey(key, firstPage) {
  if (key.length !== 32 || firstPage.length !== PAGE) return false
  const mac = macKey(key, firstPage)
  try { return authenticated(firstPage, 0, 1, mac) } finally { mac.fill(0) }
}
function decryptPage(input, offset, number, key, mac) {
  check(authenticated(input, offset, number, mac))
  const skip = number === 1 ? 16 : 0
  const cipher = createDecipheriv('aes-256-cbc', key, input.subarray(offset + 4016, offset + 4032))
  cipher.setAutoPadding(false)
  const plain = Buffer.concat([cipher.update(input.subarray(offset + skip, offset + 4016)), cipher.final()])
  const page = Buffer.alloc(PAGE)
  if (skip) page.write('SQLite format 3\0', 'latin1')
  plain.copy(page, skip); plain.fill(0)
  return page
}
function checksum(data, offset, count, little, sum) {
  for (let i = offset; i < offset + count; i += 8) {
    sum[0] = (sum[0] + (little ? data.readUInt32LE(i) : data.readUInt32BE(i)) + sum[1]) >>> 0
    sum[1] = (sum[1] + (little ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)) + sum[0]) >>> 0
  }
}
export function decryptSnapshot(key, db, wal = Buffer.alloc(0)) {
  check(key.length === 32 && db.length >= PAGE && db.length % PAGE === 0 && db.length <= MAX_PAGES * PAGE)
  check(wal.length <= MAX_PAGES * 4120 + 32)
  const mac = macKey(key, db)
  let output
  try {
    const first = decryptPage(db, 0, 1, key, mac)
    let count = first.readUInt32BE(28)
    first.fill(0)
    const committed = new Map(), pending = new Map()
    if (wal.length) {
      check(wal.length >= 32)
      const magic = wal.readUInt32BE(0), little = magic === 0x377f0682, sum = [0, 0]
      check((little || magic === 0x377f0683) && wal.readUInt32BE(4) === 3007000 && wal.readUInt32BE(8) === PAGE)
      checksum(wal, 0, 24, little, sum)
      check(sum[0] === wal.readUInt32BE(24) && sum[1] === wal.readUInt32BE(28))
      for (let at = 32; at + 4120 <= wal.length; at += 4120) {
        if (!wal.subarray(at + 8, at + 16).equals(wal.subarray(16, 24))) break
        checksum(wal, at, 8, little, sum); checksum(wal, at + 24, PAGE, little, sum)
        check(sum[0] === wal.readUInt32BE(at + 16) && sum[1] === wal.readUInt32BE(at + 20))
        const page = wal.readUInt32BE(at), size = wal.readUInt32BE(at + 4)
        check(page > 0 && page <= MAX_PAGES)
        pending.set(page, at + 24)
        if (size) {
          check(size <= MAX_PAGES)
          count = size
          for (const [number, offset] of pending) committed.set(number, offset)
          pending.clear()
        }
      }
    }
    check(count > 0 && count <= MAX_PAGES)
    output = Buffer.alloc(count * PAGE)
    for (let number = 1; number <= count; number++) {
      const offset = committed.get(number), source = offset === undefined ? db : wal
      const at = offset ?? (number - 1) * PAGE
      check(at + PAGE <= source.length)
      const page = decryptPage(source, at, number, key, mac)
      page.copy(output, (number - 1) * PAGE); page.fill(0)
    }
    output[18] = output[19] = 1
    const result = output; output = null
    return result
  } finally { mac.fill(0); output?.fill(0) }
}
export function readSnapshot(file, key) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const db = read(file), wal = read(file + '-wal', true)
    let again, walAgain
    try {
      again = read(file); walAgain = read(file + '-wal', true)
      if (db.equals(again) && wal.equals(walAgain)) return decryptSnapshot(key, db, wal)
    } finally { db.fill(0); wal.fill(0); again?.fill(0); walAgain?.fill(0) }
  }
  throw Error('Database changed during snapshot')
}
