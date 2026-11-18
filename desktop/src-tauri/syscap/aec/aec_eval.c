// aec_eval — offline measurement of loro_aec (ADR-0040). No device, no call.
//
//   aec_eval                         synthetic far/near signals (the CI test)
//   aec_eval far.wav near.wav        real speech: 16 kHz mono s16 WAVs
//
// The microphone is SIMULATED the way a MacBook in a call hears it: the far end
// (what the speakers play — the system track) through a room response, delayed
// and attenuated, plus the person's own speech (near end) and a little noise.
// Timeline (seconds): far plays in [0, T/2); near speaks in [T/2 - D, T) — so
// there is an echo-only stretch, a double-talk stretch and a near-only stretch.
//
// It feeds loro_aec the way the sidecar does: mic and reference in separate,
// differently-sized pushes, the reference arriving LATE (after the mic) and
// with its timestamp slightly behind, so alignment and waiting are exercised too.
//
// Prints ERLE (echo energy removed, echo-only stretch, after convergence) and
// how much of the near end survives (near-only stretch); exits 1 below the floor.
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "loro_aec.h"

#define RATE 16000
#ifndef AEC_FRAME
#define AEC_FRAME 160
#endif
#ifndef AEC_TAIL_MS
#define AEC_TAIL_MS 300
#endif

static float *read_wav16(const char *path, int *n) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *b = malloc((size_t)len);
    if (!b || fread(b, 1, (size_t)len, f) != (size_t)len) { fclose(f); free(b); return NULL; }
    fclose(f);
    long pos = 12;
    while (pos + 8 <= len) {
        uint32_t sz = b[pos + 4] | b[pos + 5] << 8 | b[pos + 6] << 16 | (uint32_t)b[pos + 7] << 24;
        if (!memcmp(b + pos, "data", 4)) {
            long avail = len - (pos + 8);
            if (sz && sz < avail) avail = sz;
            *n = (int)(avail / 2);
            float *x = malloc(sizeof(float) * (size_t)*n);
            for (int i = 0; i < *n; i++) {
                int16_t s = (int16_t)(b[pos + 8 + 2 * i] | b[pos + 9 + 2 * i] << 8);
                x[i] = s / 32768.0f;
            }
            free(b);
            return x;
        }
        pos += 8 + sz + (sz & 1);
    }
    free(b);
    return NULL;
}

static void put32(FILE *f, uint32_t v) { fputc(v & 255, f); fputc(v >> 8 & 255, f); fputc(v >> 16 & 255, f); fputc(v >> 24 & 255, f); }
static void put16(FILE *f, uint16_t v) { fputc(v & 255, f); fputc(v >> 8 & 255, f); }

static void write_wav16(const char *path, const float *x, int n) {
    FILE *f = fopen(path, "wb");
    if (!f) return;
    fwrite("RIFF", 1, 4, f); put32(f, 36 + 2 * (uint32_t)n); fwrite("WAVEfmt ", 1, 8, f);
    put32(f, 16); put16(f, 1); put16(f, 1); put32(f, RATE); put32(f, RATE * 2); put16(f, 2); put16(f, 16);
    fwrite("data", 1, 4, f); put32(f, 2 * (uint32_t)n);
    for (int i = 0; i < n; i++) {
        float s = x[i] * 32767.0f;
        put16(f, (uint16_t)(int16_t)(s > 32767 ? 32767 : s < -32768 ? -32768 : s));
    }
    fclose(f);
}

static uint32_t rng = 12345;
static float noise(void) {
    rng = rng * 1664525u + 1013904223u;
    return ((rng >> 8) / 16777216.0f) * 2.0f - 1.0f;
}

// Speech-like: noise-excited and voiced syllables of 150-300 ms with pauses.
static void synth_speech(float *x, int n, float pitch, uint32_t seed) {
    rng = seed;
    float lp = 0, ph = 0;
    int i = 0;
    while (i < n) {
        int syl = (int)(RATE * (0.15f + 0.15f * (noise() + 1) / 2));
        int gap = (int)(RATE * (0.03f + 0.12f * (noise() + 1) / 2));
        float f0 = pitch * (0.85f + 0.3f * (noise() + 1) / 2);
        for (int k = 0; k < syl && i < n; k++, i++) {
            float env = sinf((float)M_PI * k / syl);
            ph += 2.0f * (float)M_PI * f0 / RATE;
            float voiced = 0;
            for (int h = 1; h <= 12; h++) voiced += sinf(ph * h) / h;
            lp = 0.7f * lp + 0.3f * noise();
            x[i] = 0.25f * env * (0.6f * voiced + 0.6f * lp);
        }
        for (int k = 0; k < gap && i < n; k++, i++) x[i] = 0;
    }
}

static double energy(const float *x, int a, int b) {
    double e = 0;
    for (int i = a; i < b; i++) e += (double)x[i] * x[i];
    return e / (b - a > 0 ? b - a : 1);
}

int main(int argc, char **argv) {
    int nf = 0, nn = 0;
    float *far_src = NULL, *near_src = NULL;
    if (argc == 3) {
        far_src = read_wav16(argv[1], &nf);
        near_src = read_wav16(argv[2], &nn);
        if (!far_src || !near_src) { fprintf(stderr, "aec_eval: cannot read the WAVs\n"); return 2; }
    }
    const int T = RATE * 24;          // 24 s
    const int half = T / 2;
    const int dt = RATE * 3;          // 3 s of double talk
    float *far = calloc(T, sizeof(float)), *near = calloc(T, sizeof(float));
    float *echo = calloc(T, sizeof(float)), *mic = calloc(T, sizeof(float));
    float *out = calloc(T + RATE, sizeof(float));
    if (far_src) {
        for (int i = 0; i < half && i < nf; i++) far[i] = far_src[i];
        for (int i = 0; i < T - (half - dt) && i < nn; i++) near[half - dt + i] = near_src[i];
    } else {
        synth_speech(far, half, 120.0f, 7);
        synth_speech(near + (half - dt), T - (half - dt), 210.0f, 99);
    }

    // speaker → mic: 40 ms of latency + a 120 ms decaying room response, loud
    // (a laptop's speakers sit centimetres from its microphone)
    const int delay = RATE * 40 / 1000, rir_len = RATE * 120 / 1000;
    float *rir = calloc(rir_len, sizeof(float));
    rng = 4242;
    rir[0] = 0.6f;
    for (int k = 1; k < rir_len; k++) rir[k] = 0.25f * noise() * expf(-6.0f * k / rir_len);
    for (int i = 0; i < T; i++) {
        double acc = 0;
        for (int k = 0; k < rir_len; k++) {
            int j = i - delay - k;
            if (j >= 0) acc += rir[k] * far[j];
        }
        echo[i] = (float)acc;
        mic[i] = echo[i] + near[i] + 0.0005f * noise();
    }

    // 160-sample frames (10 ms), 300 ms tail, 50 ms lead, 400 ms max wait
    LoroAec *st = loro_aec_new(RATE, AEC_FRAME, RATE * AEC_TAIL_MS / 1000, RATE * 50 / 1000, RATE * 400 / 1000);
    if (!st) { fprintf(stderr, "aec_eval: init failed\n"); return 2; }
    // the reference is TIMESTAMPED 20 ms late and DELIVERED 120 ms after the mic
    const int ts_skew = RATE * 20 / 1000, arrive_lag = RATE * 120 / 1000;
    int got = 0, ref_sent = 0;
    const int mic_chunk = 441, ref_chunk = 480;
    for (int m = 0; m < T; m += mic_chunk) {
        int n = m + mic_chunk <= T ? mic_chunk : T - m;
        loro_aec_push_mic(st, m, mic + m, n);
        while (ref_sent + ref_chunk <= m + n - arrive_lag && ref_sent < half) {
            loro_aec_push_ref(st, ref_sent + ts_skew, far + ref_sent, ref_chunk);
            ref_sent += ref_chunk;
        }
        got += loro_aec_pull(st, out + got, T + RATE - got, 0);
    }
    got += loro_aec_pull(st, out + got, T + RATE - got, 1);
    loro_aec_free(st);
    if (got != T) { fprintf(stderr, "aec_eval: %d samples out for %d in — output must be contiguous\n", got, T); return 1; }

    // echo-only stretch after 6 s of convergence (MDF needs 3-6 s on speech:
    // measured 15.8 dB over 3-9 s vs 29.8 dB over 6-9 s); near-only stretch
    // after the far end stops
    int ea = RATE * 6, eb = half - dt, na = half + RATE, nb = T;
    double erle = 10 * log10(energy(mic, ea, eb) / (energy(out, ea, eb) + 1e-12));
    // The canceller's own latency: the lag at which the output best matches the
    // near end. The sidecar must shift its anchor by it (the e= of every word).
    int best_lag = 0;
    double err = 1e30;
    for (int lag = 0; lag <= 640; lag++) {
        double e = 0;
        for (int i = na; i < nb - lag; i++) e += (double)(out[i + lag] - near[i]) * (out[i + lag] - near[i]);
        e /= (nb - lag - na);
        if (e < err) { err = e; best_lag = lag; }
    }
    printf("aec_eval: output latency %d samples (%.1f ms)\n", best_lag, best_lag * 1000.0 / RATE);
    // Waveform SNR understates: MDF's DC notch (~46 Hz high-pass) shifts the
    // phase of low harmonics. The gain is the "was the person eaten?" number.
    double near_snr = 10 * log10(energy(near, na, nb) / (err + 1e-12));
    double near_gain = 10 * log10((energy(out, na, nb) + 1e-12) / (energy(near, na, nb) + 1e-12));
    printf("aec_eval (%s): ERLE %.1f dB (echo only, converged) | near end kept: gain %.1f dB "
           "(waveform SNR %.1f dB)\n",
           far_src ? "speech" : "synthetic", erle, near_gain, near_snr);
    // AEC_EVAL_OUT=<dir>: write mic.wav (before) and out.wav (after), to listen
    // or to transcribe with whisper-cli.
    const char *dir = getenv("AEC_EVAL_OUT");
    if (dir) {
        char p[1024];
        snprintf(p, sizeof p, "%s/mic.wav", dir);
        write_wav16(p, mic, T);
        snprintf(p, sizeof p, "%s/out.wav", dir);
        write_wav16(p, out, T);
    }
    free(far); free(near); free(echo); free(mic); free(out); free(rir);
    free(far_src); free(near_src);
    // The floor: 20 dB of echo removed once converged, and the near end within
    // [-3, +1] dB of itself (the canceller must not eat the person speaking).
    if (erle < 20.0 || near_gain < -3.0 || near_gain > 1.0) {
        fprintf(stderr, "aec_eval: below the floor (ERLE >= 20 dB, near gain within [-3, 1] dB)\n");
        return 1;
    }
    return 0;
}
