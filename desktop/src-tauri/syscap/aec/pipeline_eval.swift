// pipeline_eval — the sidecar's echo-cancellation path, offline (ADR-0040).
//
//   pipeline_eval                      synthetic far/near
//   pipeline_eval far.wav near.wav     real speech (any format AVAudioFile reads)
//
// aec_eval measures the C canceller on a ready-made 16 kHz timeline. This one
// runs what loro-syscap runs ABOVE it — AecPipeline.swift — on buffers shaped
// like the real ones: the system track as 48 kHz STEREO ScreenCaptureKit-sized
// buffers, the microphone as a 44.1 kHz MONO device (a rate the system track
// does not share) in 4096-frame taps, each stamped with a host time, the
// reference timestamped 20 ms late and delivered 120 ms after the mic. If the
// resampling, downmix or host-time placement were wrong, the echo would not
// line up and the ERLE would collapse.
//
// Exit 1 below the floor (ERLE >= 20 dB converged; near end within [-3, +1] dB).

import AVFoundation
import Foundation

@main
struct PipelineEval {
    static let sysRate = 48_000.0, micRate = 44_100.0

    static func load(_ path: String, rate: Double) -> [Float]? {
        guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
              let inBuf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
              (try? f.read(into: inBuf)) != nil else { return nil }
        return resample(inBuf, to: rate)
    }

    static func resample(_ buf: AVAudioPCMBuffer, to rate: Double) -> [Float] {
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let conv = AVAudioConverter(from: buf.format, to: fmt)!
        conv.downmix = true
        let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * rate / buf.format.sampleRate) + 1024)!
        var fed = false
        _ = conv.convert(to: out, error: nil) { _, st in
            if fed { st.pointee = .endOfStream; return nil }
            fed = true; st.pointee = .haveData; return buf
        }
        return Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength)))
    }

    static func mono(_ x: [Float], rate: Double) -> AVAudioPCMBuffer {
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(x.count))!
        b.frameLength = AVAudioFrameCount(x.count)
        x.withUnsafeBufferPointer { b.floatChannelData![0].update(from: $0.baseAddress!, count: x.count) }
        return b
    }

    static var seed: UInt32 = 1
    static func rnd() -> Float {
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return Float(seed >> 8) / 16_777_216 * 2 - 1
    }

    // speech-like syllables (same recipe as aec_eval.c)
    static func synth(_ n: Int, rate: Double, pitch: Float, s: UInt32) -> [Float] {
        seed = s
        var x = [Float](repeating: 0, count: n)
        var i = 0, lp: Float = 0, ph: Float = 0
        while i < n {
            let syl = Int(rate * Double(0.15 + 0.15 * (rnd() + 1) / 2))
            let gap = Int(rate * Double(0.03 + 0.12 * (rnd() + 1) / 2))
            let f0 = pitch * (0.85 + 0.3 * (rnd() + 1) / 2)
            var k = 0
            while k < syl && i < n {
                let env = sinf(Float.pi * Float(k) / Float(syl))
                ph += 2 * Float.pi * f0 / Float(rate)
                var v: Float = 0
                for h in 1...12 { v += sinf(ph * Float(h)) / Float(h) }
                lp = 0.7 * lp + 0.3 * rnd()
                // more noise than aec_eval: a harmonic-heavy excitation is narrowband
                // and converges slowly (measured 14.7 dB here vs 24.9 dB with this
                // mix; real speech: 29 dB)
                x[i] = 0.25 * env * (0.6 * v + 1.5 * lp)
                k += 1; i += 1
            }
            i += gap
        }
        return x
    }

    static func energy(_ x: ArraySlice<Float>) -> Double {
        x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, x.count))
    }

    static func main() {
        let a = CommandLine.arguments
        let total = 24.0, half = 12.0, dt = 3.0
        let nSys = Int(sysRate * total)
        var far48 = [Float](repeating: 0, count: nSys)
        var nearSrc: [Float]
        if a.count == 3, let f = load(a[1], rate: sysRate), let n = load(a[2], rate: micRate) {
            for i in 0..<min(f.count, Int(sysRate * half)) { far48[i] = f[i] }
            nearSrc = n
        } else {
            let f = synth(Int(sysRate * half), rate: sysRate, pitch: 120, s: 7)
            for i in 0..<f.count { far48[i] = f[i] }
            nearSrc = synth(Int(micRate * (total - half + dt)), rate: micRate, pitch: 210, s: 99)
        }
        // what the speakers play, as the microphone (44.1 kHz) hears it: 40 ms of
        // latency + a 120 ms decaying room response
        let far44 = resample(mono(far48, rate: sysRate), to: micRate)
        let nMic = Int(micRate * total)
        let delay = Int(micRate * 0.04), rirLen = Int(micRate * 0.12)
        seed = 4242
        var rir = [Float](repeating: 0, count: rirLen)
        rir[0] = 0.6
        for k in 1..<rirLen { rir[k] = 0.25 * rnd() * expf(-6 * Float(k) / Float(rirLen)) }
        var mic = [Float](repeating: 0, count: nMic), near = [Float](repeating: 0, count: nMic)
        let nearStart = Int(micRate * (half - dt))
        for i in 0..<nMic {
            if i >= nearStart && i - nearStart < nearSrc.count { near[i] = nearSrc[i - nearStart] }
            var acc: Float = 0
            var k = 0
            while k < rirLen {
                let j = i - delay - k
                if j >= 0 && j < far44.count { acc += rir[k] * far44[j] }
                k += 4 // sparse taps keep the simulation fast; still a smeared room
            }
            mic[i] = acc + near[i] + 0.0005 * rnd()
        }

        var out: [Float] = []
        let lock = NSLock()
        guard let aec = EchoCanceller(sink: { x in lock.lock(); out += x; lock.unlock() }) else {
            print("pipeline_eval: canceller init failed"); exit(2)
        }
        let micConv = TimelineConverter(), sysConv = TimelineConverter()
        let host0 = 1000.0 // arbitrary host-time origin, seconds
        let stereo = AVAudioFormat(standardFormatWithSampleRate: sysRate, channels: 2)!
        let sysChunk = 1024, micChunk = 4096
        var sysSent = 0
        var origin: Double?
        var m = 0
        while m < nMic {
            let n = min(micChunk, nMic - m)
            let t = host0 + Double(m) / micRate
            if origin == nil { origin = t }
            if let (s, st) = micConv.convert(mono(Array(mic[m..<m + n]), rate: micRate), hostSeconds: t, origin: origin!) {
                aec.pushMic(s, at: st)
            }
            m += n
            // the system buffers that have "arrived" by now: 120 ms behind, stamped 20 ms late
            let arrived = Double(m) / micRate - 0.12
            while sysSent + sysChunk <= nSys && Double(sysSent + sysChunk) / sysRate <= arrived {
                let b = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: AVAudioFrameCount(sysChunk))!
                b.frameLength = AVAudioFrameCount(sysChunk)
                for c in 0..<2 {
                    for k in 0..<sysChunk { b.floatChannelData![c][k] = far48[sysSent + k] }
                }
                let ts = host0 + Double(sysSent) / sysRate + 0.02
                if let (s, st) = sysConv.convert(b, hostSeconds: ts, origin: origin!) { aec.pushReference(s, at: st) }
                sysSent += sysChunk
            }
        }
        aec.finish()

        let mic16 = resample(mono(mic, rate: micRate), to: 16_000)
        let near16 = resample(mono(near, rate: micRate), to: 16_000)
        let r = 16_000.0
        let ea = Int(r * 6), eb = Int(r * (half - dt)), na = Int(r * (half + 1)), nb = min(out.count, near16.count)
        let erle = 10 * log10(energy(mic16[ea..<eb]) / (energy(out[ea..<eb]) + 1e-12))
        let gain = 10 * log10((energy(out[na..<nb]) + 1e-12) / (energy(near16[na..<nb]) + 1e-12))
        print(String(format: "pipeline_eval (%@): %d samples in, %d out | ERLE %.1f dB (echo only, converged) | near end kept: gain %.1f dB",
                     a.count == 3 ? "speech" : "synthetic", mic16.count, out.count, erle, gain))
        if let dir = ProcessInfo.processInfo.environment["AEC_EVAL_OUT"] {
            for (name, x) in [("pipeline_mic", mic16), ("pipeline_out", out)] {
                let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
                if let f = try? AVAudioFile(forWriting: URL(fileURLWithPath: "\(dir)/\(name).wav"), settings: fmt.settings) {
                    try? f.write(from: mono(x, rate: 16_000))
                }
            }
        }
        // contiguous: one cleaned sample per mic sample (± the resampler's edge)
        if abs(out.count - mic16.count) > 64 || erle < 20 || gain < -3 || gain > 1 {
            print("pipeline_eval: below the floor (contiguous output, ERLE >= 20 dB, near gain within [-3, 1] dB)")
            exit(1)
        }
    }
}
