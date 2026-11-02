import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { decryptSnapshot, verifyKey, readSnapshot } from '../lib/snapshot.mjs'
import { readMac, macProfile, protectedWeChat, requireReadableWeChat } from '../lib/mac.mjs'

const key = Buffer.alloc(32, 7), salt = Buffer.alloc(16, 9), iv = Buffer.alloc(16, 11)
function encrypted(text, number = 1) {
  const plain = Buffer.alloc(4096), skip = number === 1 ? 16 : 0
  plain.write('SQLite format 3\0', 'latin1'); plain.writeUInt32BE(1, 28); plain[18] = plain[19] = 2
  plain.write(text, 100)
  const cipher = createCipheriv('aes-256-cbc', key, iv); cipher.setAutoPadding(false)
  const data = Buffer.concat([cipher.update(plain.subarray(skip, 4016)), cipher.final(), iv])
  const mac = pbkdf2Sync(key, salt.map(b => b ^ 0x3a), 2, 32, 'sha512'), index = Buffer.alloc(4)
  index.writeUInt32LE(number)
  const hash = createHmac('sha512', mac).update(data).update(index).digest()
  return Buffer.concat([...(skip ? [salt] : []), data, hash])
}
function wal(frames) {
  const data = Buffer.alloc(32 + frames.length * 4120), sum = [0, 0]
  const checksum = (at, size) => {
    for (let i = at; i < at + size; i += 8) {
      sum[0] = (sum[0] + data.readUInt32LE(i) + sum[1]) >>> 0
      sum[1] = (sum[1] + data.readUInt32LE(i + 4) + sum[0]) >>> 0
    }
  }
  data.writeUInt32BE(0x377f0682, 0); data.writeUInt32BE(3007000, 4); data.writeUInt32BE(4096, 8)
  data.fill(5, 16, 24); checksum(0, 24)
  data.writeUInt32BE(sum[0], 24); data.writeUInt32BE(sum[1], 28)
  frames.forEach(({ image, commit, page = 1 }, i) => {
    const at = 32 + i * 4120
    data.writeUInt32BE(page, at); data.writeUInt32BE(commit, at + 4)
    data.copy(data, at + 8, 16, 24); image.copy(data, at + 24)
    checksum(at, 8); checksum(at + 24, 4096)
    data.writeUInt32BE(sum[0], at + 16); data.writeUInt32BE(sum[1], at + 20)
  })
  return data
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wechat-mac-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('Mac snapshot authenticates ciphertext, key, page number and committed WAL', () => {
  const db = encrypted('old'), committed = encrypted('new'), uncommitted = encrypted('pending')
  const journal = wal([{ image: committed, commit: 1 }, { image: uncommitted, commit: 0 }])
  const before = Buffer.from(db), beforeWal = Buffer.from(journal)
  assert.equal(verifyKey(key, db), true)
  assert.equal(verifyKey(Buffer.alloc(32), db), false)
  const image = decryptSnapshot(key, db, journal)
  assert.equal(image.subarray(100, 103).toString(), 'new')
  assert.equal(image[18], 1); assert.equal(image[19], 1)
  assert.deepEqual(db, before); assert.deepEqual(journal, beforeWal)
  const corrupt = Buffer.from(db); corrupt[100] ^= 1
  assert.throws(() => decryptSnapshot(key, corrupt))
  const badWal = Buffer.from(journal); badWal[50] ^= 1
  assert.throws(() => decryptSnapshot(key, db, badWal))
  assert.throws(() => decryptSnapshot(key, db, wal([{ image: encrypted('wrong', 2), page: 1, commit: 1 }])))
  assert.throws(() => decryptSnapshot(key, db, Buffer.alloc(5)))
})
test('Mac stable snapshot leaves database and WAL files unchanged', t => {
  const file = path.join(directory(t), 'contact.db'), db = encrypted('original')
  fs.writeFileSync(file, db)
  assert.equal(readSnapshot(file, key).subarray(100, 108).toString(), 'original')
  assert.deepEqual(fs.readFileSync(file), db)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['contact.db'])
})
test('Mac uses the existing Query parser, reports missing keys, and rejects account drift', async t => {
  const root = directory(t), storage = path.join(root, 'self_fixture/db_storage')
  for (const relative of ['contact/contact.db', 'session/session.db', 'message/message_0.db', 'message/message_1.db']) {
    const file = path.join(storage, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encrypted('fixture'))
  }
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,alias TEXT,verify_flag INTEGER,description TEXT,is_in_chat_room INTEGER);
    INSERT INTO contact VALUES('g@chatroom','课程群','','',0,'',1);
    CREATE TABLE SessionTable(username TEXT,last_timestamp INTEGER,unread_count INTEGER,summary TEXT,is_hidden INTEGER,last_msg_sender TEXT);
    INSERT INTO SessionTable VALUES('g@chatroom',1792116000,1,'通知',0,'u');
    CREATE TABLE Name2Id(user_name TEXT);`)
  const options = { root, helper: path.join(storage, 'contact/contact.db'), loadKey: async () => Buffer.from(key), snapshot: () => db.serialize(), pid: async () => 123, checkAccess: async () => {} }
  assert.equal((await readMac({ op: 'list', limit: 50 }, options)).chats[0].name, '课程群')
  assert.equal((await readMac({ op: 'status' }, options)).running, true)
  assert.equal((await readMac({ op: 'status' }, { ...options, pid: async () => 0 })).running, false)
  await assert.rejects(readMac({ op: 'status' }, { ...options, loadKey: async () => null }), e => e.status === 'wechat_mac_setup_required')
  const partial = await readMac({ op: 'read', limit: 50 }, { ...options, loadKey: async file => file.endsWith('message_1.db') ? null : Buffer.from(key) })
  assert.equal(partial.partial, true); assert.equal(partial.skippedShards, 1)
  await assert.rejects(readMac({ op: 'list', profile: 'other' }, options), e => e.status === 'profile_not_found')
  await assert.rejects(readMac({ op: 'download' }, options), e => e.status === 'unsupported_operation')
  fs.mkdirSync(path.join(root, 'other/db_storage/contact'), { recursive: true })
  fs.writeFileSync(path.join(root, 'other/db_storage/contact/contact.db'), '')
  assert.throws(() => macProfile(root), e => e.status === 'multiple_wechat_profiles')
})
test('native Mac helper verifies the same SQLCipher page and codec layout as the JS reader', { skip: process.platform !== 'darwin' }, t => {
  const dir = directory(t), source = fileURLToPath(new URL('../scripts/local/mac-key.cpp', import.meta.url))
  const driver = path.join(dir, 'probe.cpp'), binary = path.join(dir, 'probe')
  fs.writeFileSync(driver, `#define main helper_main\n#include ${JSON.stringify(source)}\n#undef main
    int main() {
      unsigned char key[32], found[32], ctx[144] = {}, cipher[64] = {}; Target target;
      if (fread(key, 32, 1, stdin) != 1 || fread(target.page.data(), 4096, 1, stdin) != 1) return 1;
      if (!verify(key, target)) return 2;
      uint64_t salt = reinterpret_cast<uint64_t>(target.page.data()), cp = reinterpret_cast<uint64_t>(cipher), kp = reinterpret_cast<uint64_t>(key);
      memcpy(ctx + 64, &salt, 8); memcpy(ctx + 96, &cp, 8); memcpy(cipher + 8, &kp, 8);
      if (!codec(mach_task_self(), reinterpret_cast<uint64_t>(ctx), target, found) || memcmp(found, key, 32)) return 3;
      target.page[100] ^= 1;
      return verify(key, target) ? 4 : 0;
    }`)
  execFileSync('xcrun', ['clang++', '-std=c++17', '-Wno-deprecated-declarations', driver, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', binary], { stdio: 'pipe' })
  execFileSync(binary, [], { input: Buffer.concat([key, encrypted('fixture')]), stdio: ['pipe', 'pipe', 'pipe'] })
})

test('protected official WeChat is identified before password authorization', async () => {
  const flags = 'CodeDirectory v=20500 flags=0x10000(runtime) hashes=35525+7'
  const plist = '<plist><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>'
  assert.equal(protectedWeChat(flags, plist), true)
  assert.equal(protectedWeChat(flags, '<key>com.apple.security.get-task-allow</key><false/>'), true)
  assert.equal(protectedWeChat(flags, '<key>com.apple.security.get-task-allow</key>\n<true/>'), false)
  assert.equal(protectedWeChat('flags=0x2(adhoc)', plist), false)
  const calls = []
  await assert.rejects(requireReadableWeChat(async () => 123, async (command, args) => {
    calls.push(command)
    if (command === '/bin/ps') return { stdout: '/Applications/WeChat.app/Contents/MacOS/WeChat\n' }
    return args.includes('--entitlements') ? { stdout: plist } : { stderr: flags }
  }), e => e.status === 'wechat_process_protected')
  assert.deepEqual(calls, ['/bin/ps', '/usr/bin/codesign', '/usr/bin/codesign'])
})
