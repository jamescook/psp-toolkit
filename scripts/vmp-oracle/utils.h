#ifndef _UTIL_H_
#define _UTIL_H_

#include <stdio.h>
#include <stdint.h>
#include <stddef.h>

// Stub replacing apollo-psp's real include/utils.h, which pulls in an
// external, unvendored <apollo.h> from a sibling "Apollo Save Tool" project
// that isn't part of the apollo-psp checkout on its own. This declares only
// the handful of helpers vmp_resign.c actually calls -- see harness_main.c
// for the implementations. vmp_resign.c itself is compiled unmodified; this
// stub changes nothing about the signing logic under test.
#define LOG(fmt, ...) do { fprintf(stderr, fmt "\n", ##__VA_ARGS__); } while (0)

void dump_data(const uint8_t *data, size_t size);
int read_buffer(const char *path, uint8_t **data, size_t *size);
int write_buffer(const char *path, uint8_t *data, size_t size);

#endif /* !_UTIL_H_ */
