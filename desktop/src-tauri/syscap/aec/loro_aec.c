// loro_aec — see loro_aec.h and ADR-0040.
#include "loro_aec.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"

#ifndef LORO_AEC_NOISE_DB
#define LORO_AEC_NOISE_DB (-3)
#endif
#ifndef LORO_AEC_ECHO_DB
#define LORO_AEC_ECHO_DB (-40)
#endif
#ifndef LORO_AEC_ECHO_ACTIVE_DB
#define LORO_AEC_ECHO_ACTIVE_DB (-15)
#endif

struct LoroAec {
    int rate, frame, tail, lead, max_wait;
    SpeexEchoState *echo;
    SpeexPreprocessState *pp;
    // far end: a ring addressed by absolute timeline index
    float *ref;
    int64_t ref_len;  // ring capacity
    int64_t ref_hi;   // one past the highest index written; -1 before the first push
    // near end: FIFO of samples, each with its own timeline index
    float *mic;
    int64_t *pos;
    int mic_cap, mic_head, mic_len;
    spx_int16_t *in16, *ref16, *out16;
};

static spx_int16_t to16(float v) {
    float s = v * 32767.0f;
    if (s > 32767.0f) s = 32767.0f;
    if (s < -32768.0f) s = -32768.0f;
    return (spx_int16_t)lrintf(s);
}

LoroAec *loro_aec_new(int rate, int frame, int tail, int lead, int max_wait) {
    if (rate <= 0 || frame <= 0 || tail < frame || lead < 0 || max_wait < frame) return NULL;
    LoroAec *st = calloc(1, sizeof *st);
    if (!st) return NULL;
    st->rate = rate; st->frame = frame; st->tail = tail; st->lead = lead; st->max_wait = max_wait;
    st->echo = speex_echo_state_init(frame, tail);
    st->pp = speex_preprocess_state_init(frame, rate);
    // 4 s of reference: far more than tail + lead + max_wait
    st->ref_len = (int64_t)rate * 4;
    st->ref = calloc((size_t)st->ref_len, sizeof(float));
    st->ref_hi = -1;
    st->mic_cap = max_wait * 2 + frame * 4;
    st->mic = calloc((size_t)st->mic_cap, sizeof(float));
    st->pos = calloc((size_t)st->mic_cap, sizeof(int64_t));
    st->in16 = calloc((size_t)frame, sizeof(spx_int16_t));
    st->ref16 = calloc((size_t)frame, sizeof(spx_int16_t));
    st->out16 = calloc((size_t)frame, sizeof(spx_int16_t));
    if (!st->echo || !st->pp || !st->ref || !st->mic || !st->pos || !st->in16 || !st->ref16 || !st->out16) {
        loro_aec_free(st);
        return NULL;
    }
    speex_echo_ctl(st->echo, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
    // The preprocessor is here for its residual-echo suppressor only. Noise
    // suppression and AGC are what the meeting mic must NOT get (ADR-0022 §24):
    // they flatten speech and hurt recognition. But speex applies NO spectral
    // gain at all with denoise off (preprocess.c: "If noise suppression is off,
    // don't apply the gain") — measured: ERLE identical with and without the
    // preprocessor. So denoise stays on with its noise attenuation capped at
    // LORO_AEC_NOISE_DB (barely audible), and the echo attenuation does the work.
    int off = 0, on = 1;
    int noise_db = LORO_AEC_NOISE_DB, echo_db = LORO_AEC_ECHO_DB, echo_active_db = LORO_AEC_ECHO_ACTIVE_DB;
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_DENOISE, &on);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_NOISE_SUPPRESS, &noise_db);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, &echo_db);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE, &echo_active_db);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_AGC, &off);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_DEREVERB, &off);
    speex_preprocess_ctl(st->pp, SPEEX_PREPROCESS_SET_ECHO_STATE, st->echo);
    return st;
}

void loro_aec_free(LoroAec *st) {
    if (!st) return;
    if (st->echo) speex_echo_state_destroy(st->echo);
    if (st->pp) speex_preprocess_state_destroy(st->pp);
    free(st->ref); free(st->mic); free(st->pos);
    free(st->in16); free(st->ref16); free(st->out16);
    free(st);
}

static float ref_at(const LoroAec *st, int64_t i) {
    if (st->ref_hi < 0 || i < 0 || i >= st->ref_hi || i < st->ref_hi - st->ref_len) return 0.0f;
    return st->ref[i % st->ref_len];
}

void loro_aec_push_ref(LoroAec *st, int64_t start, const float *x, int n) {
    if (!st || !x || n <= 0 || start < 0) return;
    int64_t end = start + n;
    // a jump forward leaves a gap: it is silence, not whatever the ring held
    if (st->ref_hi >= 0 && start > st->ref_hi) {
        int64_t from = st->ref_hi;
        if (start - from > st->ref_len) from = start - st->ref_len;
        for (int64_t i = from; i < start; i++) st->ref[i % st->ref_len] = 0.0f;
    }
    for (int k = 0; k < n; k++) st->ref[(start + k) % st->ref_len] = x[k];
    if (end > st->ref_hi) st->ref_hi = end;
}

void loro_aec_push_mic(LoroAec *st, int64_t start, const float *x, int n) {
    if (!st || !x || n <= 0) return;
    for (int k = 0; k < n; k++) {
        if (st->mic_len == st->mic_cap) {
            // backlog overflow can only happen if nobody pulls; drop the oldest
            st->mic_head = (st->mic_head + 1) % st->mic_cap;
            st->mic_len--;
        }
        int at = (st->mic_head + st->mic_len) % st->mic_cap;
        st->mic[at] = x[k];
        st->pos[at] = start + k;
        st->mic_len++;
    }
}

int loro_aec_pending(const LoroAec *st) { return st ? st->mic_len : 0; }

int loro_aec_pull(LoroAec *st, float *out, int max, int flush) {
    if (!st || !out) return 0;
    int written = 0;
    const int f = st->frame;
    while (st->mic_len > 0 && max - written >= f) {
        int real = st->mic_len >= f ? f : st->mic_len;
        if (real < f && !flush) break;
        int64_t first = st->pos[st->mic_head];
        int64_t need = first + st->lead + f;
        int ready = flush || st->ref_hi >= need || st->mic_len >= st->max_wait;
        if (!ready) break;
        for (int k = 0; k < f; k++) {
            if (k < real) {
                int at = (st->mic_head + k) % st->mic_cap;
                st->in16[k] = to16(st->mic[at]);
                st->ref16[k] = to16(ref_at(st, st->pos[at] + st->lead));
            } else {
                st->in16[k] = 0;
                st->ref16[k] = 0;
            }
        }
        speex_echo_cancellation(st->echo, st->in16, st->ref16, st->out16);
        speex_preprocess_run(st->pp, st->out16);
        for (int k = 0; k < real; k++) out[written + k] = st->out16[k] / 32768.0f;
        written += real;
        st->mic_head = (st->mic_head + real) % st->mic_cap;
        st->mic_len -= real;
    }
    return written;
}
