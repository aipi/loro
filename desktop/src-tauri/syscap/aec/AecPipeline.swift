// AecPipeline — the sidecar's echo-cancellation glue (ADR-0040): placing the
// microphone and the system audio on one 16 kHz timeline by host time, and the
// Swift face of loro_aec.c. Compiled into loro-syscap AND into aec/pipeline_eval
// (the offline test), so the code under test is the code that ships.

import AVFoundation

// ---- ADR-0040 · the timeline both tracks share -------------------------------
//
// Host time (mach ticks) is the one clock the microphone tap and ScreenCaptureKit
// both stamp their buffers with. The echo canceller works on a sample timeline at
// 16 kHz whose index 0 is the first microphone sample; each buffer is placed on it
// by its host time, so the far end (system) and the near end (mic) line up without
// either having to be "the" clock.
let aecRate: Double = 16_000
let aecFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: aecRate,
                              channels: 1, interleaved: false)!
func hostSecondsNow() -> Double { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }

// Any input format → 16 kHz mono Float32, as a stream (the resampler keeps its
// state between buffers), placed on the timeline. A buffer whose host time
// disagrees with the running position by more than 20 ms (a dropout, a device
// change) re-syncs the position instead of drifting.
final class TimelineConverter {
    private var converter: AVAudioConverter?
    private var inFormat: AVAudioFormat?
    private var next: Int64?

    // Returns the converted samples and their timeline start, or nil.
    func convert(_ buf: AVAudioPCMBuffer, hostSeconds: Double, origin: Double) -> ([Float], Int64)? {
        if inFormat == nil || inFormat! != buf.format {
            converter = AVAudioConverter(from: buf.format, to: aecFormat)
            converter?.downmix = true // stereo system / multi-mic arrays → mono
            inFormat = buf.format
        }
        guard let conv = converter else { return nil }
        let ratio = aecRate / buf.format.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: aecFormat, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        if err != nil || out.frameLength == 0 { return nil }
        let n = Int(out.frameLength)
        let samples = Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: n))
        let stamped = Int64(((hostSeconds - origin) * aecRate).rounded())
        let start: Int64
        if let nx = next, abs(nx - stamped) <= Int64(aecRate * 0.02) { start = nx } else { start = stamped }
        next = start + Int64(n)
        return (samples, start)
    }
}

// ADR-0040 — Loro's OWN copy of the microphone, with the speakers' sound taken
// out. The far-end reference is the system track this same process captures;
// nothing here touches a device, so what the meeting app hears from the
// microphone is exactly what it would hear without Loro.
final class EchoCanceller {
    // 10 ms frames, 300 ms echo tail, 50 ms reference look-ahead, and at most
    // 400 ms of waiting for a reference that never comes (a silent machine:
    // ScreenCaptureKit delivers nothing) — measured in aec_eval, see the ADR.
    static let frame: Int32 = 160
    private let st: OpaquePointer
    private let queue = DispatchQueue(label: "loro.syscap.aec")
    private let sink: ([Float]) -> Void
    private var scratch = [Float](repeating: 0, count: 16_000)

    init?(sink: @escaping ([Float]) -> Void) {
        guard let s = loro_aec_new(Int32(aecRate), EchoCanceller.frame, 4800, 800, 6400) else { return nil }
        st = s
        self.sink = sink
    }
    deinit { loro_aec_free(st) }

    // The canceller's own delay: output sample k is input sample k - frame
    // (measured: 160 samples, aec_eval). The file's t=0 is that much earlier.
    static var latencyMs: Double { Double(frame) * 1000 / aecRate }

    func pushReference(_ x: [Float], at start: Int64) {
        queue.async {
            x.withUnsafeBufferPointer { loro_aec_push_ref(self.st, start, $0.baseAddress, Int32($0.count)) }
            self.drain(flush: false)
        }
    }

    func pushMic(_ x: [Float], at start: Int64) {
        queue.async {
            x.withUnsafeBufferPointer { loro_aec_push_mic(self.st, start, $0.baseAddress, Int32($0.count)) }
            self.drain(flush: false)
        }
    }

    func finish() { queue.sync { self.drain(flush: true) } }

    private func drain(flush: Bool) {
        while true {
            let n = scratch.withUnsafeMutableBufferPointer {
                loro_aec_pull(st, $0.baseAddress, Int32($0.count), flush ? 1 : 0)
            }
            if n <= 0 { return }
            sink(Array(scratch[0..<Int(n)]))
        }
    }
}

