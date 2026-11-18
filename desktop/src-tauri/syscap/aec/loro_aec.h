// loro_aec — acoustic echo cancellation of Loro's OWN copy of the meeting
// microphone, using the system-audio track as the far-end reference (ADR-0040).
//
// It never touches a device: it is pure signal processing on two sample streams
// the sidecar already has. What the meeting app (Meet, Zoom) receives from the
// microphone is unaffected — no VoiceProcessingIO, no ducking, no input volume.
//
// Both streams live on ONE timeline, in samples at `rate`, derived from host time
// by the caller. The microphone is processed frame by frame once the reference
// covering that frame (plus `lead` samples of look-ahead) has arrived — or, when
// the system is silent and delivers nothing, once the mic backlog exceeds
// `max_wait` samples, with the missing reference taken as silence.
#ifndef LORO_AEC_H
#define LORO_AEC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct LoroAec LoroAec;

// rate: Hz (16000). frame: samples per step (e.g. 160 = 10 ms). tail: echo
// filter length in samples (e.g. 4800 = 300 ms). lead: how far the reference is
// advanced against the mic (covers a reference that is timestamped slightly
// LATE). max_wait: mic backlog after which a frame is processed without waiting
// for its reference. Returns NULL on bad arguments or allocation failure.
LoroAec *loro_aec_new(int rate, int frame, int tail, int lead, int max_wait);
void loro_aec_free(LoroAec *st);

// Feed the far end (system audio, mono, at `rate`) starting at timeline index
// `start`. Out-of-order or overlapping pushes overwrite; gaps read as silence.
void loro_aec_push_ref(LoroAec *st, int64_t start, const float *x, int n);

// Feed the near end (microphone, mono, at `rate`). The output is CONTIGUOUS: the
// microphone's samples come out in order, one out per one in, whatever `start`
// says. `start` only places them on the timeline to find their reference; a
// jump re-syncs that position.
void loro_aec_push_mic(LoroAec *st, int64_t start, const float *x, int n);

// Write up to `max` cleaned microphone samples into `out`; returns how many.
// With `flush` != 0, every pending sample is processed now (stop), padding the
// last partial frame internally; the padding is not returned.
int loro_aec_pull(LoroAec *st, float *out, int max, int flush);

// How many mic samples are waiting to be processed.
int loro_aec_pending(const LoroAec *st);

#ifdef __cplusplus
}
#endif

#endif
