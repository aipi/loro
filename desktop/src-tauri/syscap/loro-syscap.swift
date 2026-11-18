// loro-syscap — capture the computer's system audio to a WAV file, via
// ScreenCaptureKit (macOS 13+). No virtual audio driver, no Audio MIDI setup:
// the OS shows a single Screen Recording permission prompt on first run.
//
// Usage:   loro-syscap <system.wav> [--mic <mic.wav>]
// Stops cleanly on SIGINT/SIGTERM and finalizes the WAV(s). Our own process audio
// is excluded so the app's own sounds are not recorded.
//
// ADR-0039: with `--mic`, the sidecar ALSO records the microphone, into its OWN
// file. The two tracks never share a buffer, a file or a stdout line: system
// audio arrives as ScreenCaptureKit `.audio` buffers into <system.wav>, the
// microphone through an AVAudioEngine input tap into <mic.wav>, and each reports
// its own first-sample anchor. The microphone is opened RAW: AVAudioEngine's voice
// processing (the VoiceProcessingIO unit: echo canceller, AGC, ducking of other
// audio) is opt-in (`setVoiceProcessingEnabled` with true), and this file never
// turns it on.
//
// Privacy (BR-1/BR-8): audio never leaves the machine; this tool only writes the
// local WAV path it was given and prints event-oriented status to stderr — no
// transcript content, no PII.

import AppKit
import AVFoundation
import ScreenCaptureKit

// stderr logging (stdout stays clean for any future machine-readable use)
func elog(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

// The machine-readable stdout lines. One writer, so the two capture threads can
// never interleave half lines. Never any audio content (BR-8).
let stdoutLock = NSLock()
func emit(_ line: String) {
    stdoutLock.lock()
    print(line)
    fflush(stdout)
    stdoutLock.unlock()
}
func nowEpochMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

// ADR-0039 — the microphone track. Raw input only: no voice processing, so no
// VPIO unit, no AGC, no ducking. Writes ONLY <mic.wav>.
final class MicCapturer {
    private let outputURL: URL
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private let lock = NSLock()
    private var observer: NSObjectProtocol?

    init(output: URL) { self.outputURL = output }

    // Asks for the microphone (TCC) if needed and starts the tap. A refusal or a
    // machine with no input device is NOT fatal: the system track keeps recording
    // and the parent is told on stdout, so the meeting degrades to one track
    // instead of failing.
    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            begin()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async {
                    if ok { self.begin() } else { self.unavailable("denied") }
                }
            }
        default:
            unavailable("denied")
        }
    }

    private func unavailable(_ why: String) {
        elog("syscap: microphone unavailable (\(why))")
        emit("mic-unavailable \(why)")
    }

    private func installTap() -> Bool {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in
            self?.write(buf)
        }
        return true
    }

    private func begin() {
        let input = engine.inputNode
        // The default is off, and it must stay off (ADR-0039).
        if input.isVoiceProcessingEnabled {
            try? input.setVoiceProcessingEnabled(false)
        }
        guard installTap() else {
            unavailable("no-input-device")
            return
        }
        // The default input device changed (headset plugged in, AirPods): the
        // engine stops itself. The file keeps the format it was opened with, so
        // audio at another rate cannot be appended: the mic track ends there and
        // says so instead of writing a corrupt file.
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in self?.reconfigure() }
        do {
            try engine.start()
            elog("syscap: capturing microphone (raw, no voice processing) -> \(outputURL.path)")
        } catch {
            input.removeTap(onBus: 0)
            unavailable("start-failed")
        }
    }

    private func reconfigure() {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let fmt = input.outputFormat(forBus: 0)
        lock.lock()
        let current = file?.processingFormat
        lock.unlock()
        if let current = current,
           current.sampleRate != fmt.sampleRate || current.channelCount != fmt.channelCount {
            unavailable("format-changed")
            return
        }
        guard installTap() else {
            unavailable("no-input-device")
            return
        }
        do { try engine.start() } catch { unavailable("restart-failed") }
    }

    private func write(_ buf: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        do {
            if file == nil {
                file = try AVAudioFile(forWriting: outputURL, settings: buf.format.settings,
                                       commonFormat: .pcmFormatFloat32, interleaved: false)
                // ADR-0025, for the mic track: this instant is <mic.wav>'s t=0.
                emit("mic-first-sample-epoch-ms \(nowEpochMs())")
            }
            try file?.write(from: buf)
        } catch {
            elog("syscap: mic write error: \(error.localizedDescription)")
        }
    }

    func stop() {
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        file = nil // flush/close
        lock.unlock()
    }
}

@available(macOS 13.0, *)
final class Capturer: NSObject, SCStreamOutput {
    private let outputURL: URL
    private var stream: SCStream?
    private var file: AVAudioFile?
    private let queue = DispatchQueue(label: "loro.syscap.audio")

    init(output: URL) { self.outputURL = output }

    func start() async throws {
        // ScreenCaptureKit needs a display in the content filter even for an
        // audio-only capture. Pick the first available display.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "loro-syscap", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no display available"])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        // Minimal video config: SCK still runs a video pipeline; we add no video
        // output, so frames are produced-and-dropped cheaply.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
        elog("syscap: capturing system audio -> \(outputURL.path)")
    }

    func stop() async {
        if let stream = stream { try? await stream.stopCapture() }
        file = nil // flush/close
        elog("syscap: stopped")
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        do {
            try sampleBuffer.withAudioBufferList { abl, _ in
                guard let absd = sampleBuffer.formatDescription?.audioStreamBasicDescription,
                      let fmt = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate,
                                              channels: absd.mChannelsPerFrame),
                      let pcm = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: abl.unsafePointer)
                else { return }
                if file == nil {
                    // Match the incoming format; transcribe step downsamples to
                    // 16k mono via ffmpeg, so we keep the native 48k float WAV.
                    file = try AVAudioFile(forWriting: outputURL, settings: fmt.settings,
                                           commonFormat: .pcmFormatFloat32, interleaved: false)
                    // ADR-0025: THIS instant is the file's t=0, and the parent has
                    // no other way to know it — it was estimating, and a meeting's
                    // two tracks ended up on clocks up to seconds apart. One
                    // machine-readable line on stdout, at the only moment it is
                    // true. Never any audio content (BR-8).
                    emit("first-sample-epoch-ms \(nowEpochMs())")
                }
                try file?.write(from: pcm)
            }
        } catch {
            elog("syscap: write error: \(error.localizedDescription)")
        }
    }
}

// ---- entrypoint ----
let args = CommandLine.arguments
guard args.count == 2 || (args.count == 4 && args[2] == "--mic") else {
    elog("usage: loro-syscap <system.wav> [--mic <mic.wav>]")
    exit(2)
}
let outputURL = URL(fileURLWithPath: args[1])
let micCapturer: MicCapturer? = args.count == 4 ? MicCapturer(output: URL(fileURLWithPath: args[3])) : nil

guard #available(macOS 13.0, *) else {
    elog("syscap: requires macOS 13 or newer")
    exit(3)
}

let capturer = Capturer(output: outputURL)

// graceful stop on SIGINT/SIGTERM: stop the stream, finalize the file, exit 0
func installSignalHandler(_ sig: Int32) -> DispatchSourceSignal {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        Task {
            micCapturer?.stop()
            await capturer.stop()
            exit(0)
        }
    }
    src.resume()
    return src
}
let sigint = installSignalHandler(SIGINT)
let sigterm = installSignalHandler(SIGTERM)
_ = (sigint, sigterm) // keep alive

// The parent (Loro) signals a clean stop by closing our stdin. Watch for EOF and
// finalize the WAV — more portable than relying on a specific signal.
DispatchQueue.global(qos: .utility).async {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { // EOF: stdin closed
            DispatchQueue.main.async {
                Task { micCapturer?.stop(); await capturer.stop(); exit(0) }
            }
            return
        }
    }
}

Task {
    do {
        try await capturer.start()
        // Only after the system track is up: a Screen Recording denial must still
        // exit fast with code 4, and a microphone prompt in front of it would hide it.
        await MainActor.run { micCapturer?.start() }
    } catch {
        let msg = error.localizedDescription
        elog("syscap: start failed: \(msg)")
        // TCC denial: point the user at the exact permission and open the pane.
        if msg.lowercased().contains("tcc") || msg.lowercased().contains("screen")
            || msg.lowercased().contains("captura de tela") {
            elog("syscap: grant Screen Recording permission in System Settings > "
                + "Privacy & Security > Screen Recording, then run again")
            let url = "x-apple.systempreferences:com.apple.preference.security"
                + "?Privacy_ScreenCapture"
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            exit(4) // distinct code so callers can show a permission hint
        }
        exit(1)
    }
}

// keep the process alive until a signal arrives
RunLoop.main.run()
