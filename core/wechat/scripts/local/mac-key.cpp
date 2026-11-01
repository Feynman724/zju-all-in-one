// macOS counterpart of runtime-key.cs and chat-key-cache.cs.
// Read-only Mach memory access; only HMAC-verified keys leave the process, over a pipe.
#include <CommonCrypto/CommonCrypto.h>
#include <Security/Security.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <libproc.h>
#include <sys/stat.h>
#include <unistd.h>
#include <array>
#include <vector>
#include <string>
#include <fstream>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <cstdlib>

static void wipe(void *p, size_t n) { volatile unsigned char *b = static_cast<volatile unsigned char *>(p); while (n--) *b++ = 0; }
using Bytes = std::vector<unsigned char>;
struct Target { std::array<unsigned char, 4096> page; bool found = false; };
static const char *service = "CampusAgent.WeChat.DatabaseKey";
static bool verify(const unsigned char *key, const Target &target) {
  unsigned char salt[16], macKey[32], message[4020] = {}, mac[64];
  for (int i = 0; i < 16; i++) salt[i] = target.page[i] ^ 0x3a;
  CCKeyDerivationPBKDF(kCCPBKDF2, reinterpret_cast<const char *>(key), 32,
    salt, 16, kCCPRFHmacAlgSHA512, 2, macKey, 32);
  memcpy(message, target.page.data() + 16, 4016); message[4016] = 1;
  CCHmac(kCCHmacAlgSHA512, macKey, 32, message, sizeof(message), mac);
  unsigned char diff = 0;
  for (int i = 0; i < 64; i++) diff |= mac[i] ^ target.page[4032 + i];
  wipe(macKey, sizeof(macKey));
  return diff == 0;
}
static int hex(unsigned char c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}
static bool decode(const unsigned char *input, unsigned char *out) {
  for (int i = 0; i < 32; i++) {
    int a = hex(input[2*i]), b = hex(input[2*i+1]);
    if (a < 0 || b < 0) return false;
    out[i] = (a << 4) | b;
  }
  return true;
}
static bool readMemory(mach_port_t task, uint64_t address, void *out, size_t size) {
  mach_vm_size_t got = 0;
  return address >= 0x10000 && mach_vm_read_overwrite(task, address, size,
    reinterpret_cast<mach_vm_address_t>(out), &got) == KERN_SUCCESS && got == size;
}
static bool codec(mach_port_t task, uint64_t address, Target &target, unsigned char *key) {
  unsigned char ctx[144], cipher[64], salt[16], blob[99], decoded[99], mask[32];
  if (!readMemory(task, address, ctx, sizeof(ctx))) return false;
  auto pointer = [](const unsigned char *p) { uint64_t n; memcpy(&n, p, 8); return n; };
  for (int offset : {64, 72}) {
    if (!readMemory(task, pointer(ctx + offset), salt, 16) || memcmp(salt, target.page.data(), 16)) continue;
    for (int p : {offset + 32, offset + 40}) {
      if (!readMemory(task, pointer(ctx + p), cipher, sizeof(cipher))) continue;
      uint32_t size; memcpy(&size, ctx + 32, 4);
      if (size == 99 && readMemory(task, pointer(cipher + 32), blob, 99)) {
        for (const char *alphabet : {"0123456789abcdef", "0123456789ABCDEF"}) {
          for (int j = 66; j < 98; j++) {
            unsigned char b = salt[(j - 66) / 2];
            mask[j % 32] = blob[j] ^ alphabet[(j % 2 == 0 ? b >> 4 : b & 15)];
          }
          for (int j = 0; j < 99; j++) decoded[j] = blob[j] ^ mask[j % 32];
          bool valid = decoded[0] == 'x' && decoded[1] == '\'' && decoded[98] == '\'' && decode(decoded + 2, key) && verify(key, target);
          wipe(decoded, sizeof(decoded)); wipe(mask, sizeof(mask));
          if (valid) { wipe(blob, sizeof(blob)); return true; }
        }
        wipe(blob, sizeof(blob));
      }
      for (int k = 8; k <= 56; k += 8)
        if (readMemory(task, pointer(cipher + k), key, 32) && verify(key, target)) return true;
    }
  }
  return false;
}
static int scan(int argc, char **argv) {
  if (argc < 4 || argc > 260 || !getenv("SUDO_UID") || geteuid() != 0) return 2;
  const int pid = atoi(argv[2]);
  struct proc_bsdinfo info = {};
  char process[PROC_PIDPATHINFO_MAXSIZE] = {};
  if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_uid != static_cast<uid_t>(strtoul(getenv("SUDO_UID"), nullptr, 10)) ||
      !proc_pidpath(pid, process, sizeof(process))) return 2;
  std::string executable(process), suffix = "/WeChat.app/Contents/MacOS/WeChat";
  if (executable.size() < suffix.size() || executable.compare(executable.size() - suffix.size(), suffix.size(), suffix)) return 2;
  std::vector<Target> targets;
  for (int i = 3; i < argc; i++) {
    Target target;
    std::ifstream file(argv[i], std::ios::binary);
    if (!file.read(reinterpret_cast<char *>(target.page.data()), 4096)) return 2;
    targets.push_back(target);
  }
  mach_port_t task = MACH_PORT_NULL;
  if (task_for_pid(mach_task_self(), pid, &task) != KERN_SUCCESS) {
    fprintf(stderr, "macOS 拒绝读取微信进程。请在系统设置 → 隐私与安全性 → 开发者工具中允许 Terminal，再重试。不会修改微信或关闭 SIP。\n");
    return 3;
  }
  const uint32_t signature[] = {256000, 2, 16, 32, 16, 16, 4096};
  Bytes buffer(1024 * 1024); unsigned char key[32] = {};
  mach_vm_address_t address = 0;
  uint64_t total = 0; size_t found = 0;
  auto started = std::chrono::steady_clock::now();
  auto expired = [&] { return total >= 2ULL * 1024 * 1024 * 1024 || std::chrono::steady_clock::now() - started > std::chrono::seconds(90); };
  while (!expired() && found < targets.size()) {
    mach_vm_size_t size = 0;
    vm_region_basic_info_data_64_t region = {};
    mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
    mach_port_t object = MACH_PORT_NULL;
    if (mach_vm_region(task, &address, &size, VM_REGION_BASIC_INFO_64, reinterpret_cast<vm_region_info_t>(&region), &count, &object) != KERN_SUCCESS) break;
    if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
    if (!size || address + size <= address) break;
    if ((region.protection & (VM_PROT_READ | VM_PROT_WRITE)) == (VM_PROT_READ | VM_PROT_WRITE)) {
      for (uint64_t offset = 0; offset < size && !expired() && found < targets.size();) {
        size_t wanted = std::min<uint64_t>(buffer.size(), size - offset);
        total += wanted;
        if (readMemory(task, address + offset, buffer.data(), wanted)) {
          for (uint32_t index = 0; index < targets.size(); index++) {
            auto &target = targets[index]; if (target.found) continue;
            auto confirm = [&] {
              if (!verify(key, target)) return false;
              // Framed binary output: target index (LE uint32), then 32 key bytes.
              if (fwrite(&index, 4, 1, stdout) != 1 || fwrite(key, 32, 1, stdout) != 1) exit(4);
              fflush(stdout); target.found = true; found++; return true;
            };
            // Same codec signature and salt-relative key candidates as runtime-key.cs.
            auto sig = reinterpret_cast<const unsigned char *>(signature);
            for (size_t pos = 0; pos + sizeof(signature) <= wanted && !target.found;) {
              auto hit = std::search(buffer.begin() + pos, buffer.begin() + wanted, sig, sig + sizeof(signature));
              if (hit == buffer.begin() + wanted) break;
              pos = hit - buffer.begin();
              if (address + offset + pos >= 4 && codec(task, address + offset + pos - 4, target, key)) confirm();
              pos += sizeof(signature);
            }
            for (int format = 0; format < 3 && !target.found; format++) {
              Bytes needle;
              if (!format) needle.assign(target.page.begin(), target.page.begin() + 16);
              else for (int j = 0; j < 16; j++) {
                const char *alphabet = format == 1 ? "0123456789abcdef" : "0123456789ABCDEF";
                needle.push_back(alphabet[target.page[j] >> 4]); needle.push_back(alphabet[target.page[j] & 15]);
              }
              for (size_t pos = 0; pos + needle.size() <= wanted && !target.found;) {
                auto hit = std::search(buffer.begin() + pos, buffer.begin() + wanted, needle.begin(), needle.end());
                if (hit == buffer.begin() + wanted) break;
                pos = hit - buffer.begin();
                for (int delta : {-64, -48, -40, -32, 16, 24, 32}) {
                  if ((format && delta != -64) || (!format && delta == -64)) continue;
                  int64_t at = static_cast<int64_t>(pos) + delta;
                  if (at < 0 || static_cast<uint64_t>(at) + (format ? 64 : 32) > wanted) continue;
                  if (!format) memcpy(key, buffer.data() + at, 32);
                  else if (!decode(buffer.data() + at, key)) continue;
                  if (confirm()) break;
                }
                pos += needle.size();
              }
            }
            wipe(key, sizeof(key));
          }
        }
        wipe(buffer.data(), buffer.size());
        if (wanted <= 256) break;
        offset += wanted - 256;
      }
    }
    address += size;
  }
  wipe(key, sizeof(key)); mach_port_deallocate(mach_task_self(), task);
  return found ? 0 : 5;
}
int main(int argc, char **argv) {
  // Never print keys into a terminal, and never write to the root keychain.
  if (argc < 3 || isatty(STDOUT_FILENO)) return 2;
  if (!strcmp(argv[1], "scan")) return scan(argc, argv);
  if (argc != 3 || geteuid() == 0 || strlen(argv[2]) != 64) return 2;
  for (const char *c = argv[2]; *c; c++) if (hex(*c) < 0) return 2;
  SecKeychainItemRef item = nullptr;
  UInt32 length = 0; void *data = nullptr;
  OSStatus status = SecKeychainFindGenericPassword(nullptr, strlen(service), service,
    strlen(argv[2]), argv[2], &length, &data, &item);
  if (!strcmp(argv[1], "get")) {
    if (status == errSecSuccess && length == 32) fwrite(data, length, 1, stdout);
    else status = errSecItemNotFound;
  } else if (!strcmp(argv[1], "store")) {
    unsigned char key[32];
    if (fread(key, 1, 32, stdin) != 32 || fgetc(stdin) != EOF) status = errSecParam;
    else if (status == errSecSuccess) status = SecKeychainItemModifyAttributesAndData(item, nullptr, 32, key);
    else if (status == errSecItemNotFound) status = SecKeychainAddGenericPassword(nullptr,
      strlen(service), service, strlen(argv[2]), argv[2], 32, key, nullptr);
    wipe(key, sizeof(key));
  } else status = errSecParam;
  if (data) { wipe(data, length); SecKeychainItemFreeContent(nullptr, data); }
  if (item) CFRelease(item);
  return status == errSecSuccess ? 0 : 6;
}
