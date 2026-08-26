// Thin driver around apollo-psp's REAL, unmodified source/vmp_resign.c.
//
// vmp_resign.c is compiled as-is (see verify-vmp-oracle.cjs for the compile
// command) -- this file only supplies plain stdio implementations of the
// generic I/O helpers it expects from utils.h (see utils.h in this
// directory for why those aren't the project's real ones). None of this
// touches the actual signing/hashing logic being verified.

#include <stdio.h>
#include <stdlib.h>
#include "utils.h"

int read_buffer(const char *path, uint8_t **data, size_t *size) {
  FILE *f = fopen(path, "rb");
  if (!f) return -1;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
  long sz = ftell(f);
  if (sz < 0) { fclose(f); return -1; }
  rewind(f);

  uint8_t *buf = malloc((size_t)sz);
  if (!buf) { fclose(f); return -1; }
  if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return -1; }
  fclose(f);

  *data = buf;
  *size = (size_t)sz;
  return 0;
}

int write_buffer(const char *path, uint8_t *data, size_t size) {
  FILE *f = fopen(path, "wb");
  if (!f) return -1;
  size_t written = fwrite(data, 1, size, f);
  fclose(f);
  return written == size ? 0 : -1;
}

void dump_data(const uint8_t *data, size_t size) {
  for (size_t i = 0; i < size; i++) fprintf(stderr, "%02x", data[i]);
  fprintf(stderr, "\n");
}

// Declared, not defined, by vmp_resign.c -- no header exports it (it's a
// standalone C file within the larger apollo-psp application), so we declare
// the one entry point we need directly.
extern int vmp_resign(const char *src_vmp);

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <path-to-vmp-file>\n", argv[0]);
    return 2;
  }
  // vmp_resign() re-signs in place: recomputes the seed+signature fields of
  // an existing VMP_SIZE file using the real generateHash(), and overwrites
  // the file with the result.
  return vmp_resign(argv[1]) ? 0 : 1;
}
